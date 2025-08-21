/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {createBlob, decode, decodeAudioData} from './utils';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() isConnecting = false;
  @state() status = 'Ready for live conversation...';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private inputNode: GainNode | null = null;
  private outputNode: GainNode | null = null;
  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: AudioBufferSourceNode | MediaStreamAudioSourceNode | null =
    null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      --primary-color: #4285f4;
      --danger-color: #ea4335;
      --dark-grey: #3c4043;
      --light-grey: #5f6368;
      --border-color: #e0e0e0;
      --bg-color: #ffffff;
    }
    .phone-container {
      width: 375px;
      height: 812px;
      border: 1px solid var(--border-color);
      border-radius: 40px;
      background: var(--bg-color);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
      font-family: 'Google Sans', sans-serif, system-ui;
    }
    .content {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 20px;
      gap: 16px;
    }
    .call-button {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: background-color 0.3s ease;
      background-color: var(--primary-color);
      box-shadow: 0 4px 12px rgba(66, 133, 244, 0.4);
    }
    .call-button:hover:not(:disabled) {
      opacity: 0.9;
    }
    .call-button:disabled {
      background-color: #e0e0e0;
      cursor: not-allowed;
      box-shadow: none;
    }
    .call-button.end-call {
      background-color: var(--danger-color);
      box-shadow: 0 4px 12px rgba(234, 67, 53, 0.4);
    }
    .call-button.recording {
      animation: pulse 1.5s infinite;
    }
    .call-button svg {
      fill: white;
      width: 36px;
      height: 36px;
    }
    .call-text-primary {
      font-size: 18px;
      color: var(--dark-grey);
      margin-top: 8px;
    }
    .call-text-secondary {
      font-size: 14px;
      color: var(--light-grey);
    }
    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.7);
      }
      70% {
        box-shadow: 0 0 0 20px rgba(234, 67, 53, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(234, 67, 53, 0);
      }
    }
  `;

  constructor() {
    super();
    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });
  }

  private initAudio() {
    if (!this.outputAudioContext) return;
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';
    this.session = null;

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {},
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio && this.outputAudioContext && this.outputNode) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
            this.stopRecording();
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Connection closed. Tap to start again.');
            this.stopRecording();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError((e as Error).message);
      this.session = null;
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.updateStatus('Connecting...');

    try {
      // 1. Initialize Audio Contexts
      this.inputAudioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({sampleRate: 16000});
      this.outputAudioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({sampleRate: 24000});
      this.inputNode = this.inputAudioContext.createGain();
      this.outputNode = this.outputAudioContext.createGain();
      this.outputNode.connect(this.outputAudioContext.destination);
      this.initAudio();

      // 2. Initialize GenAI Session
      await this.initSession();
      if (!this.session) {
        throw new Error('Connection failed. Please try again.');
      }

      // 3. Get Microphone Access
      this.updateStatus('Requesting microphone access...');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      // 4. Setup Audio Processing Graph
      this.updateStatus('Listening...');
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return;
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      // 5. Finalize state
      this.isRecording = true;
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Error: ${(err as Error).message}`);
      // Clean up everything if any step fails
      this.stopRecording();
    } finally {
      this.isConnecting = false;
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.isConnecting) {
      return;
    }
    this.updateStatus('Ending conversation...');
    this.isRecording = false;
    this.isConnecting = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Close and release AudioContexts
    this.inputAudioContext?.close();
    this.outputAudioContext?.close();
    this.inputAudioContext = null;
    this.outputAudioContext = null;
    this.inputNode = null;
    this.outputNode = null;

    this.session = null;
    this.updateStatus('Ready for live conversation...');
  }

  render() {
    const buttonClasses = {
      'call-button': true,
      'end-call': this.isRecording,
      recording: this.isRecording,
    };

    const statusMessage = this.error || this.status;

    return html`
      <div class="phone-container">
        <div class="content">
          ${!this.isRecording
            ? html`
                <button
                  class="call-button"
                  @click=${this.startRecording}
                  ?disabled=${this.isConnecting}
                  aria-label="Start conversation">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="36px"
                    viewBox="0 0 24 24"
                    width="36px"
                    fill="#FFFFFF">
                    <path d="M0 0h24v24H0V0z" fill="none" />
                    <path
                      d="M6.54 5c.06.89.21 1.76.45 2.59l-1.2 1.2c-.41-1.2-.67-2.47-.76-3.79h1.51m10.92 0h1.51c-.09 1.32-.35 2.59-.76 3.79l-1.2-1.2c.24-.83.39-1.7.45-2.59M1 15.07l4.08-1.54c.24-.09.5.01.62.24l1.36 2.13c1.03-.59 2.16-1.32 3.19-2.36 1.03-1.03 1.77-2.16 2.36-3.19L10.47 9c-.23-.12-.34-.38-.24-.62L8.93 4.3c-.22-.64.16-1.32.83-1.32H13c.41 0 .79.17 1.06.44 2.82 2.82 4.02 6.64 4.02 9.49 0 3.53-2.87 6.4-6.4 6.4-1.99 0-3.79-.9-5.04-2.35-.37-.42-.56-.96-.56-1.51v-3.51c0-.67.68-1.1 1.32-.83z" />
                  </svg>
                </button>
                <div class="call-text-primary">
                  ${this.isConnecting
                    ? 'Connecting...'
                    : 'Tap to start live conversation'}
                </div>
                <div class="call-text-secondary">
                  ${statusMessage}
                </div>
              `
            : html`
                <button
                  class=${classMap(buttonClasses)}
                  @click=${this.stopRecording}
                  aria-label="End conversation">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="36px"
                    viewBox="0 0 24 24"
                    width="36px"
                    fill="#FFFFFF"
                    style="transform: rotate(135deg)">
                    <path d="M0 0h24v24H0V0z" fill="none" />
                    <path
                      d="M6.54 5c.06.89.21 1.76.45 2.59l-1.2 1.2c-.41-1.2-.67-2.47-.76-3.79h1.51m10.92 0h1.51c-.09 1.32-.35 2.59-.76 3.79l-1.2-1.2c.24-.83.39-1.7.45-2.59M1 15.07l4.08-1.54c.24-.09.5.01.62.24l1.36 2.13c1.03-.59 2.16-1.32 3.19-2.36 1.03-1.03 1.77-2.16 2.36-3.19L10.47 9c-.23-.12-.34-.38-.24-.62L8.93 4.3c-.22-.64.16-1.32.83-1.32H13c.41 0 .79.17 1.06.44 2.82 2.82 4.02 6.64 4.02 9.49 0 3.53-2.87 6.4-6.4 6.4-1.99 0-3.79-.9-5.04-2.35-.37-.42-.56-.96-.56-1.51v-3.51c0-.67.68-1.1 1.32-.83z" />
                  </svg>
                </button>
                <div class="call-text-primary">In conversation...</div>
                <div class="call-text-secondary">${statusMessage}</div>
              `}
        </div>
      </div>
    `;
  }
}
