class TalkCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n >= this._buf.length) {
        this.port.postMessage(this._buf.slice(0));
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('talk-capture', TalkCapture);
