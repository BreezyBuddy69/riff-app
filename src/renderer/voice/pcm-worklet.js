// PCM-Worklet: sammelt Float32-Bloecke (je ~128 Samples pro process()-Aufruf),
// wandelt sie zu Int16 um und schickt sie gebuendelt an den Main-Thread.
// Dazu eine simple Energie-VAD mit Hysterese - kein ML, nur ein grober
// Best-Effort-Trigger fuer speech-start/stop, Tuning ist bewusst unkritisch.

const DEFAULT_SPEECH_RMS = 0.02;   // ueber diesem RMS gilt ein Block als "laut"
const DEFAULT_SILENCE_RMS = 0.012; // darunter gilt er als "leise" (Luecke zwischen beiden verhindert Flattern an der Schwelle)
// Echo-Guard: solange Sable selbst per Lautsprecher spricht, hoert das Mikro
// (trotz echoCancellation:true im getUserMedia-Constraint) oft ein Restecho
// der eigenen Stimme mit - reicht das ueber die normale Schwelle, unterbricht
// sich Sable selbst (kein Barge-in durch den Nutzer, sondern durch sich
// selbst). Echo aus den Lautsprechern kommt nach der Browser-AEC typischerweise
// deutlich leiser beim Mic an als eine direkt gesprochene Unterbrechung -
// eine deutlich hoehere Schwelle laesst echtes Reinreden weiter durch,
// filtert aber den ueblichen Echo-Rest heraus. Wird von main.js waehrend
// convoTtsState 'speaking' scharf geschaltet (siehe 'echo-guard'-Kommando).
const ECHO_GUARD_SPEECH_RMS = 0.075;
const ECHO_GUARD_SILENCE_RMS = 0.045;
const DEFAULT_SPEECH_HOLD_BLOCKS = 3;   // ~3 Bloecke am Stueck ueber Schwelle -> speech-start
// 90 Bloecke a 128 Samples/16kHz = 8ms/Block -> ~720ms Stille, bevor eine
// Aeusserung als beendet gilt. War vorher 15 Bloecke (~120ms) - das ist KUERZER
// als eine normale Sprechpause (Atemholen, kurzes Ueberlegen), Sable schnitt
// darum mitten im Satz ab ("hört nicht zu"/bricht ab). 720ms ist naeher an dem,
// was andere Sprachassistenten fuer Sprechende-Erkennung nutzen.
const DEFAULT_SILENCE_HOLD_BLOCKS = 90;
const BATCH_BLOCKS = 4; // process()-Aufrufe pro postMessage, ~20-40ms je nach Samplerate - vermeidet IPC/postMessage-Chatter

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.speechRms = typeof opts.speechRms === 'number' ? opts.speechRms : DEFAULT_SPEECH_RMS;
    this.silenceRms = typeof opts.silenceRms === 'number' ? opts.silenceRms : DEFAULT_SILENCE_RMS;
    this.speechHoldBlocks = opts.speechHoldBlocks || DEFAULT_SPEECH_HOLD_BLOCKS;
    this.silenceHoldBlocks = opts.silenceHoldBlocks || DEFAULT_SILENCE_HOLD_BLOCKS;

    this.speaking = false;
    this.aboveCount = 0;
    this.belowCount = 0;
    this.echoGuard = !!opts.echoGuard;

    this.chunks = [];        // Float32Array[] seit dem letzten Flush
    this.sampleCount = 0;
    this.blocksSinceFlush = 0;
    this.lastLevel = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'echo-guard') this.echoGuard = !!event.data.on;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // RMS-Energie + simple Zero-Crossing-Rate ueber den Block
    let sumSquares = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      sumSquares += s * s;
      if (i > 0 && (channel[i - 1] >= 0) !== (s >= 0)) zeroCrossings++;
    }
    const rms = Math.sqrt(sumSquares / channel.length);
    this.lastLevel = Math.min(1, rms);
    const zcr = zeroCrossings / channel.length;

    // Hysterese: je nachdem ob wir gerade "sprechen", gilt die hoehere oder
    // die niedrigere Schwelle - verhindert Flackern direkt an der Grenze.
    // ZCR-Mindestwert filtert reines tiefes Brummen/Rumpeln grob heraus.
    const speechThreshold = this.echoGuard ? ECHO_GUARD_SPEECH_RMS : this.speechRms;
    const silenceThreshold = this.echoGuard ? ECHO_GUARD_SILENCE_RMS : this.silenceRms;
    const loud = rms > (this.speaking ? silenceThreshold : speechThreshold) && zcr > 0.01;
    let vadEvent = null;
    if (loud) {
      this.aboveCount++;
      this.belowCount = 0;
      if (!this.speaking && this.aboveCount >= this.speechHoldBlocks) {
        this.speaking = true;
        vadEvent = 'speech-start';
      }
    } else {
      this.belowCount++;
      this.aboveCount = 0;
      if (this.speaking && this.belowCount >= this.silenceHoldBlocks) {
        this.speaking = false;
        vadEvent = 'speech-stop';
      }
    }

    this.chunks.push(channel.slice());
    this.sampleCount += channel.length;
    this.blocksSinceFlush++;

    // Bei einem VAD-Uebergang sofort flushen (schnelle Reaktion), sonst nur
    // alle BATCH_BLOCKS Aufrufe.
    if (vadEvent || this.blocksSinceFlush >= BATCH_BLOCKS) {
      this.flush(vadEvent);
    }

    return true;
  }

  flush(vadEvent) {
    if (this.sampleCount === 0) {
      if (vadEvent) this.port.postMessage({ pcm: new ArrayBuffer(0), level: this.lastLevel, vadEvent });
      return;
    }

    const merged = new Int16Array(this.sampleCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const clamped = Math.max(-1, Math.min(1, chunk[i]));
        merged[offset++] = clamped * 0x7fff;
      }
    }

    this.chunks = [];
    this.sampleCount = 0;
    this.blocksSinceFlush = 0;

    // Transfer statt Copy - das ArrayBuffer gehoert danach dem Main-Thread.
    this.port.postMessage(
      { pcm: merged.buffer, level: this.lastLevel, vadEvent: vadEvent || null },
      [merged.buffer]
    );
  }
}

registerProcessor('pcm-processor', PcmProcessor);
