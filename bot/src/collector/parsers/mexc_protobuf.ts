// https://github.com/mexcdevelop/websocket-proto/tree/main
type DecodeState = {
  buf: Buffer;
  offset: number;
};

export type MexcProtobufDebugField = {
  fieldNo: number;
  wireType: number;
  value?: number | null | string;
  length?: number;
};

type MexcDepthItem = {
  price?: string;
  quantity?: string;
};

export type MexcDecodedDepth = {
  channel?: string;
  symbol?: string;
  symbolId?: string;
  createTime?: number | null;
  sendTime?: number | null;
  publicLimitDepths?: {
    asks?: MexcDepthItem[];
    bids?: MexcDepthItem[];
    eventType?: string;
    version?: string;
  };
};

export type MexcDecodedPrivateDeal = {
  price?: string;
  quantity?: string;
  amount?: string;
  tradeType?: number | null;
  isMaker?: boolean;
  isSelfTrade?: boolean;
  tradeId?: string;
  clientOrderId?: string;
  orderId?: string;
  feeAmount?: string;
  feeCurrency?: string;
  time?: number | null;
};

export type MexcDecodedPrivateDealsMessage = {
  channel?: string;
  symbol?: string;
  symbolId?: string;
  createTime?: number | null;
  sendTime?: number | null;
  privateDeals?: MexcDecodedPrivateDeal;
};

function readVarint(state: DecodeState): bigint {
  let shift = 0n;
  let out = 0n;

  while (state.offset < state.buf.length) {
    const byte = BigInt(state.buf[state.offset]);
    state.offset += 1;
    out |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return out;
    shift += 7n;
  }

  throw new Error('unexpected eof while reading protobuf varint');
}

function readLengthDelimited(state: DecodeState): Buffer {
  const len = Number(readVarint(state));
  const end = state.offset + len;
  if (end > state.buf.length) throw new Error('unexpected eof while reading protobuf length-delimited field');
  const out = state.buf.subarray(state.offset, end);
  state.offset = end;
  return out;
}

function readString(state: DecodeState): string {
  return readLengthDelimited(state).toString('utf8');
}

function toSafeNumber(value: bigint): number | null {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max) return null;
  return Number(value);
}

function skipField(state: DecodeState, wireType: number): void {
  if (wireType === 0) {
    readVarint(state);
    return;
  }
  if (wireType === 2) {
    readLengthDelimited(state);
    return;
  }
  throw new Error(`unsupported protobuf wire type: ${wireType}`);
}

export function debugMexcTopLevelFields(buf: Buffer): MexcProtobufDebugField[] {
  const state: DecodeState = { buf, offset: 0 };
  const out: MexcProtobufDebugField[] = [];

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      out.push({
        fieldNo,
        wireType,
        value: toSafeNumber(readVarint(state)),
      });
      continue;
    }

    if (wireType === 2) {
      const part = readLengthDelimited(state);
      out.push({
        fieldNo,
        wireType,
        length: part.length,
        value: part.toString('utf8'),
      });
      continue;
    }

    out.push({ fieldNo, wireType });
    skipField(state, wireType);
  }

  return out;
}

function decodeDepthItem(buf: Buffer): MexcDepthItem {
  const state: DecodeState = { buf, offset: 0 };
  const out: MexcDepthItem = {};

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNo === 1 && wireType === 2) {
      out.price = readString(state);
      continue;
    }
    if (fieldNo === 2 && wireType === 2) {
      out.quantity = readString(state);
      continue;
    }
    skipField(state, wireType);
  }

  return out;
}

function decodePublicLimitDepths(buf: Buffer): NonNullable<MexcDecodedDepth['publicLimitDepths']> {
  const state: DecodeState = { buf, offset: 0 };
  const out: NonNullable<MexcDecodedDepth['publicLimitDepths']> = { asks: [], bids: [] };

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNo === 1 && wireType === 2) {
      out.asks!.push(decodeDepthItem(readLengthDelimited(state)));
      continue;
    }
    if (fieldNo === 2 && wireType === 2) {
      out.bids!.push(decodeDepthItem(readLengthDelimited(state)));
      continue;
    }
    if (fieldNo === 3 && wireType === 2) {
      out.eventType = readString(state);
      continue;
    }
    if (fieldNo === 4 && wireType === 2) {
      out.version = readString(state);
      continue;
    }
    skipField(state, wireType);
  }

  return out;
}

function decodePrivateDeal(buf: Buffer): MexcDecodedPrivateDeal {
  const state: DecodeState = { buf, offset: 0 };
  const out: MexcDecodedPrivateDeal = {};

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    // price
    if (fieldNo === 1 && wireType === 2) {
      out.price = readString(state);
      continue;
    }

    // quantity
    if (fieldNo === 2 && wireType === 2) {
      out.quantity = readString(state);
      continue;
    }

    // amount
    if (fieldNo === 3 && wireType === 2) {
      out.amount = readString(state);
      continue;
    }

    // tradeType
    if (fieldNo === 4 && wireType === 0) {
      out.tradeType = toSafeNumber(readVarint(state));
      continue;
    }

    // isMaker
    if (fieldNo === 5 && wireType === 0) {
      out.isMaker = readVarint(state) !== 0n;
      continue;
    }

    // isSelfTrade
    if (fieldNo === 6 && wireType === 0) {
      out.isSelfTrade = readVarint(state) !== 0n;
      continue;
    }

    // tradeId
    if (fieldNo === 7 && wireType === 2) {
      out.tradeId = readString(state);
      continue;
    }

    // clientOrderId
    if (fieldNo === 8 && wireType === 2) {
      out.clientOrderId = readString(state);
      continue;
    }

    // orderId
    if (fieldNo === 9 && wireType === 2) {
      out.orderId = readString(state);
      continue;
    }

    // feeAmount
    if (fieldNo === 10 && wireType === 2) {
      out.feeAmount = readString(state);
      continue;
    }

    // feeCurrency
    if (fieldNo === 11 && wireType === 2) {
      out.feeCurrency = readString(state);
      continue;
    }

    // time
    if (fieldNo === 12 && wireType === 0) {
      out.time = toSafeNumber(readVarint(state));
      continue;
    }
    skipField(state, wireType);
  }

  return out;
}

export function decodeMexcPushDataV3ApiWrapper(buf: Buffer): MexcDecodedDepth {
  const state: DecodeState = { buf, offset: 0 };
  const out: MexcDecodedDepth = {};

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNo === 1 && wireType === 2) {
      out.channel = readString(state);
      continue;
    }
    if (fieldNo === 3 && wireType === 2) {
      out.symbol = readString(state);
      continue;
    }
    if (fieldNo === 4 && wireType === 2) {
      out.symbolId = readString(state);
      continue;
    }
    if (fieldNo === 5 && wireType === 0) {
      out.createTime = toSafeNumber(readVarint(state));
      continue;
    }
    if (fieldNo === 6 && wireType === 0) {
      out.sendTime = toSafeNumber(readVarint(state));
      continue;
    }
    if (fieldNo === 303 && wireType === 2) {
      out.publicLimitDepths = decodePublicLimitDepths(readLengthDelimited(state));
      continue;
    }
    skipField(state, wireType);
  }

  return out;
}

export function decodeMexcPrivateDealsV3ApiWrapper(buf: Buffer): MexcDecodedPrivateDealsMessage {
  const state: DecodeState = { buf, offset: 0 };
  const out: MexcDecodedPrivateDealsMessage = {};

  while (state.offset < state.buf.length) {
    const tag = Number(readVarint(state));
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNo === 1 && wireType === 2) {
      out.channel = readString(state);
      continue;
    }
    if (fieldNo === 3 && wireType === 2) {
      out.symbol = readString(state);
      continue;
    }
    if (fieldNo === 4 && wireType === 2) {
      out.symbolId = readString(state);
      continue;
    }
    if (fieldNo === 5 && wireType === 0) {
      out.createTime = toSafeNumber(readVarint(state));
      continue;
    }
    if (fieldNo === 6 && wireType === 0) {
      out.sendTime = toSafeNumber(readVarint(state));
      continue;
    }
    if (fieldNo === 306 && wireType === 2) {
      out.privateDeals = decodePrivateDeal(readLengthDelimited(state));
      continue;
    }
    skipField(state, wireType);
  }

  return out;
}
