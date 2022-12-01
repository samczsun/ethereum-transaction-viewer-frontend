import { Log } from '@ethersproject/abstract-provider';
import { NATIVE_TOKEN, TransferAction } from './actions';
import { Decoder, DecoderInput, DecoderState, hasTopic } from './types';

export class TransferDecoder extends Decoder<TransferAction> {
    async decodeCall(state: DecoderState, node: DecoderInput): Promise<TransferAction | null> {
        if (!state.isConsumed(node) && !node.value.isZero()) {
            return {
                type: 'transfer',
                operator: node.from,
                from: node.from,
                to: node.to,
                token: NATIVE_TOKEN,
                amount: node.value,
            };
        }
        return null;
    }

    async decodeLog(state: DecoderState, node: DecoderInput, log: Log): Promise<TransferAction | null> {
        if (state.isConsumed(log)) return null;
        if (!hasTopic(log, `Transfer(address,address,uint256)`)) return null;

        if (node.abi) {
            const decodedEvent = node.abi.parseLog(log);

            state.requestTokenMetadata(log.address);

            return {
                type: 'transfer',
                operator: node.from,
                token: log.address,
                from: decodedEvent.args[0],
                to: decodedEvent.args[1],
                amount: decodedEvent.args[2],
            };
        }

        return null;
    }
}