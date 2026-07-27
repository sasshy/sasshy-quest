import 'fake-indexeddb/auto';

class BroadcastChannelStub {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

Object.defineProperty(globalThis, 'BroadcastChannel', { value: BroadcastChannelStub, writable: true });
