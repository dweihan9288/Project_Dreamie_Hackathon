/**
 * Utility class for handling real-time audio streaming.
 * Specifically designed to interface with the Gemini Live API, which requires
 * 16kHz PCM audio for input and returns 24kHz PCM audio for output.
 */
export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private playbackAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  private isPlaying = false;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  
  // Required sample rates for Gemini Live API
  private sampleRate = 16000; // Input (microphone)
  private outputSampleRate = 24000; // Output (TTS)

  /**
   * Starts capturing audio from the user's microphone using AudioWorklet.
   * Converts the audio to 16kHz, 16-bit PCM, base64 encodes it, and passes it to the callback.
   * 
   * @param onData Callback function invoked with base64 encoded PCM audio chunks.
   */
  async startRecording(onData: (base64Data: string) => void) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.sampleRate,
      });
    }
    if (!this.playbackAudioContext) {
      this.playbackAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.outputSampleRate,
      });
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    
    const workletCode = `
      class RecorderWorklet extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 2048;
          this.buffer = new Float32Array(this.bufferSize);
          this.bufferIndex = 0;
        }
        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (input.length > 0) {
            const channelData = input[0];
            for (let i = 0; i < channelData.length; i++) {
              this.buffer[this.bufferIndex++] = channelData[i];
              if (this.bufferIndex >= this.bufferSize) {
                this.port.postMessage(this.buffer);
                this.buffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
              }
            }
          }
          return true;
        }
      }
      registerProcessor('recorder-worklet', RecorderWorklet);
    `;
    
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.audioContext.audioWorklet.addModule(url);
    
    this.workletNode = new AudioWorkletNode(this.audioContext, 'recorder-worklet');
    
    this.workletNode.port.onmessage = (e) => {
      const inputData = e.data as Float32Array;
      // Convert Float32 to Int16
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      // Convert Int16Array to Base64
      const buffer = new Uint8Array(pcmData.buffer);
      const base64 = btoa(String.fromCharCode.apply(null, buffer as unknown as number[]));
      onData(base64);
    };

    this.source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);
  }

  /**
   * Stops capturing audio and releases microphone resources.
   */
  stopRecording() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }

  /**
   * Decodes base64 encoded 24kHz, 16-bit PCM audio and queues it for playback.
   * 
   * @param base64Data Base64 encoded PCM audio string.
   */
  playAudio(base64Data: string) {
    if (!this.playbackAudioContext) {
      this.playbackAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.outputSampleRate,
      });
    }

    // Decode base64 to Int16Array
    const binary = atob(base64Data);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      view[i] = binary.charCodeAt(i);
    }
    const pcmData = new Int16Array(buffer);
    
    // Convert Int16 to Float32
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 32768.0;
    }

    this.isPlaying = true;
    
    const audioBuffer = this.playbackAudioContext.createBuffer(1, floatData.length, this.outputSampleRate);
    audioBuffer.getChannelData(0).set(floatData);

    const source = this.playbackAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackAudioContext.destination);

    const currentTime = this.playbackAudioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime + 0.05; // Add a small buffer to avoid underruns
    }

    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
    this.activeSources.push(source);

    source.onended = () => {
      this.activeSources = this.activeSources.filter(s => s !== source);
      if (this.activeSources.length === 0) {
        this.isPlaying = false;
      }
    };
  }

  /**
   * Clears the playback queue and stops current playback.
   */
  stopPlayback() {
    this.isPlaying = false;
    this.nextPlayTime = 0;
    this.activeSources.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors if already stopped
      }
    });
    this.activeSources = [];
  }

  /**
   * Completely stops recording and playback, and closes the audio context.
   */
  close() {
    this.stopRecording();
    this.stopPlayback();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.playbackAudioContext) {
      this.playbackAudioContext.close();
      this.playbackAudioContext = null;
    }
  }
}