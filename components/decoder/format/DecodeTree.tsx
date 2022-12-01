import { decode, format } from '../decoder';
import TreeView from '@mui/lab/TreeView';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import * as React from 'react';
import { TraceTreeItem } from '../../trace/TraceTreeItem';
import { DecoderChainAccess, DecoderInput, DecoderOutput, DecoderState, getNodeId, MetadataRequest } from '../types';
import { fetchDefiLlamaPrices, PriceMetadata, PriceMetadataContext } from '../../metadata/prices';
import { fetchTokenMetadata, TokenMetadata, TokenMetadataContext } from '../../metadata/tokens';
import { LabelMetadataContext } from '../../metadata/labels';
import { useContext } from 'react';
import { TraceEntryCall, TraceResponse, TraceEntryLog } from '../../api';
import { TraceMetadata } from '../../types';
import { ChainConfigContext } from '../../Chains';
import { TransactionMetadataContext } from '../../metadata/transaction';
import { BaseProvider } from '@ethersproject/providers';
import { Log, Provider } from '@ethersproject/abstract-provider';
import { findAffectedContract } from '../../helpers';
import * as ethers from 'ethers';
import { Interface } from '@ethersproject/abi';
import { BigNumber } from 'ethers';

export type DecodeTreeProps = {
    provider: BaseProvider;
    traceResult: TraceResponse;
    traceMetadata: TraceMetadata;
};

class ProviderDecoderChainAccess implements DecoderChainAccess {
    private provider: Provider;
    private cache: Record<string, Record<string, string>>

    constructor(provider: Provider) {
        this.provider = provider;
        this.cache = {};
    }


    async getStorageAt(address: string, slot: string): Promise<string> {
        if (!this.cache[address]) {
            this.cache[address] = {};
        }
        if (!this.cache[address][slot]) {
            this.cache[address][slot] = await this.provider.getStorageAt(address, slot);
        }
        return this.cache[address][slot];
    }
}

export const DecodeTree = (props: DecodeTreeProps) => {
    const priceMetadata = useContext(PriceMetadataContext);
    const tokenMetadata = useContext(TokenMetadataContext);
    const transactionMetadata = useContext(TransactionMetadataContext);
    const chainConfig = useContext(ChainConfigContext);

    const [data, setData] = React.useState<[DecoderOutput, MetadataRequest]>();

    React.useEffect(() => {
        const access = new ProviderDecoderChainAccess(props.provider);


        let logIndex = 0;
        let indexToPath: Record<number, string> = {};

        const flattenLogs = (node: TraceEntryCall, recursive: boolean): Array<Log> => {
            const ourLogs = node.children
                .filter((node): node is TraceEntryLog => node.type === 'log')
                .map((logNode) => {
                    const [affected] = findAffectedContract(props.traceMetadata, logNode);
                    indexToPath[logIndex] = logNode.path;
                    const log: Log = {
                        address: ethers.utils.getAddress(affected.to),
                        blockHash: '',
                        blockNumber: 0,
                        data: logNode.data,
                        logIndex: logNode.path,
                        removed: false,
                        topics: logNode.topics,
                        transactionHash: props.traceResult.txhash,
                        transactionIndex: 0,
                    };
                    return log;
                });
            if (!recursive) {
                return ourLogs;
            }

            node.children
                .filter((node): node is TraceEntryCall => node.type === 'call')
                .forEach((v) => {
                    ourLogs.push(...flattenLogs(v, true));
                });

            return ourLogs;
        };

        const remap = (node: TraceEntryCall, parentAbi?: Interface): DecoderInput => {
            let thisAbi = new Interface([
                ...props.traceMetadata.abis[node.to][node.codehash].fragments,
                ...(parentAbi?.fragments || []),
            ]);

            const logs = flattenLogs(node, false);
            const children = node.children
                .filter((node): node is TraceEntryCall => node.type === 'call')
                .map((v) => {
                    if (v.variant === 'delegatecall') {
                        return remap(v, thisAbi);
                    } else {
                        return remap(v, undefined);
                    }
                });

            return {
                id: node.path,
                type: node.variant,
                from: ethers.utils.getAddress(node.from),
                to: ethers.utils.getAddress(node.to),
                value: BigNumber.from(node.value),
                calldata: ethers.utils.arrayify(node.input),

                status: node.status == 1,
                logs: logs,

                returndata: ethers.utils.arrayify(node.output),
                children: children,

                childOrder: node.children
                    .filter((node): node is TraceEntryLog | TraceEntryCall => node.type === 'log' || node.type === 'call')
                    .map((v) => {
                        if (v.type === 'log') {
                            return ['log', logs.findIndex((log) => log.logIndex === v.path)];
                        } else {
                            return ['call', children.findIndex((child) => child.id === v.path)];
                        }
                    }),

                abi: thisAbi,
            };
        };

        const input = remap(props.traceResult.entrypoint);
        console.log("remapped input", input);
        decode(input, access)
            .then(data => {
                console.log("decoded output", data);
                setData(data)
            });
    }, [props.traceResult, props.traceMetadata]);

    let children;

    if (data) {
        const [decodedActions, requestedMetadata] = data;

        fetchDefiLlamaPrices(
            priceMetadata.updater,
            Array.from(requestedMetadata.tokens).map((token) => `${chainConfig.defillamaPrefix}:${token}`),
            transactionMetadata.block.timestamp,
        );

        fetchTokenMetadata(tokenMetadata.updater, props.provider, Array.from(requestedMetadata.tokens));

        const recursivelyGenerateTree = (node: DecoderOutput): JSX.Element[] => {
            let results: JSX.Element[] = [];
            if (node.children) {
                for (let child of node.children) {
                    results.push(...recursivelyGenerateTree(child));
                }
            }
            if (node.results.length === 0) {
                return results;
            }

            return node.results.map((v, i) => {
                let id = getNodeId(node.node) + '.result_' + i;
                return (
                    <TraceTreeItem
                        key={id}
                        nodeId={id}
                        treeContent={format(v, {
                            timestamp: transactionMetadata.block.timestamp,
                            chain: chainConfig,
                            prices: priceMetadata,
                            tokens: tokenMetadata,
                        })}
                    >
                        {results}
                    </TraceTreeItem>
                );
            });
        };

        try {
            children = recursivelyGenerateTree(decodedActions);
        } catch (e) {
            console.log('failed to generate decoded tree!', e);
        }
    }

    return (
        <>
            <TreeView
                aria-label="rich object"
                defaultCollapseIcon={<ExpandMoreIcon />}
                defaultExpandIcon={<ChevronRightIcon />}
            >
                {children}
            </TreeView>
        </>
    );
};