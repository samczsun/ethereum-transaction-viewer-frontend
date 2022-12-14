import { deepCopy } from '@ethersproject/properties';
import { fetchJson } from '@ethersproject/web';

import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { ConnectionInfo } from 'ethers/lib/utils';
import { Networkish } from '@ethersproject/networks';

// Experimental

interface RpcResult {
    jsonrpc: '2.0';
    id: number;
    result?: string;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export class JsonRpcBatchProvider extends StaticJsonRpcProvider {
    _pendingBatchAggregator?: NodeJS.Timer;
    _pendingBatch?: Array<{
        request: { method: string; params: Array<any>; id: number; jsonrpc: '2.0' };
        resolve: (result: any) => void;
        reject: (error: Error) => void;
    }>;

    constructor(url?: ConnectionInfo | string, network?: Networkish) {
        super(url, network);
    }

    send(method: string, params: Array<any>): Promise<any> {
        const request = {
            method: method,
            params: params,
            id: this._nextId++,
            jsonrpc: '2.0',
        };

        if (this._pendingBatch == null) {
            this._pendingBatch = [];
        }

        const inflightRequest: any = { request, resolve: null, reject: null };

        const promise = new Promise((resolve, reject) => {
            inflightRequest.resolve = resolve;
            inflightRequest.reject = reject;
        });

        this._pendingBatch.push(inflightRequest);

        if (!this._pendingBatchAggregator) {
            // Schedule batch for next event loop + short duration
            this._pendingBatchAggregator = setTimeout(() => this.pumpBatch(), 10);
        }

        return promise;
    }

    pumpBatch() {
        if (!this._pendingBatch) return;

        // Get the current batch and clear it, so new requests
        // go into the next batch
        const batch = this._pendingBatch.slice(0, 100);
        this._pendingBatch = this._pendingBatch.slice(100);
        this._pendingBatchAggregator = undefined;

        if (this._pendingBatch.length > 0) {
            this._pendingBatchAggregator = setTimeout(() => this.pumpBatch(), 0);
        }

        // Get the request as an array of requests
        const request = batch.map((inflight) => inflight.request);

        this.emit('debug', {
            action: 'requestBatch',
            request: deepCopy(request),
            provider: this,
        });

        return fetchJson(this.connection, JSON.stringify(request)).then(
            (result: RpcResult[]) => {
                this.emit('debug', {
                    action: 'response',
                    request: request,
                    response: result,
                    provider: this,
                });

                const resultMap = result.reduce((resultMap, payload) => {
                    resultMap[payload.id] = payload;
                    return resultMap;
                }, {} as Record<number, RpcResult>);

                // For each result, feed it to the correct Promise, depending
                // on whether it was a success or error
                batch.forEach((inflightRequest) => {
                    const payload = resultMap[inflightRequest.request.id];
                    if (payload.error) {
                        const error = new Error(payload.error.message);
                        (<any>error).code = payload.error.code;
                        (<any>error).data = payload.error.data;
                        inflightRequest.reject(error);
                    } else {
                        inflightRequest.resolve(payload.result);
                    }
                });
            },
            (error) => {
                this.emit('debug', {
                    action: 'response',
                    error: error,
                    request: request,
                    provider: this,
                });

                batch.forEach((inflightRequest) => {
                    inflightRequest.reject(error);
                });
            },
        );
    }
}
