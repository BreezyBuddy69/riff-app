// PCM(Int16, mono) -> WAV. Reines JS, keine Abhaengigkeit - der Renderer liefert
// bereits Int16-Frames (siehe pcm-worklet.js), hier wird nur noch der 44-Byte
// RIFF/WAVE-Header davorgesetzt. OpenRouters /audio/transcriptions-Endpunkt
// (Whisper) nimmt WAV als multipart-Datei.
function encodeWav(int16Buffer, sampleRate) {
  const dataSize = int16Buffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt-Chunk-Groesse (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(1, 22); // Kanaele = 1 (mono)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate = sampleRate * blockAlign
  buffer.writeUInt16LE(2, 32); // BlockAlign = kanaele * bitsPerSample/8
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  int16Buffer.copy(buffer, 44);

  return buffer;
}

module.exports = { encodeWav };
