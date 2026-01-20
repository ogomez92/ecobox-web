import type { AudioEffects, EffectPreset } from '$lib/types';

const PRESET_EQ: Record<EffectPreset, number[]> = {
	flat: [0, 0, 0, 0, 0, 0],
	dialog: [0, 3, 6, 4, 2, 0],    // Boost mids for speech clarity
	bass: [6, 4, 0, 0, 0, 0],      // Boost low frequencies
	treble: [0, 0, 0, 2, 4, 6],    // Boost high frequencies
	custom: [0, 0, 0, 0, 0, 0]
};

export class AudioEffectsChain {
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaElementAudioSourceNode | null = null;
	private gainNode: GainNode | null = null;
	private volumeBoostNode: GainNode | null = null;
	private eqNodes: BiquadFilterNode[] = [];
	private compressorNode: DynamicsCompressorNode | null = null;
	private highPassNode: BiquadFilterNode | null = null;
	private convolverNode: ConvolverNode | null = null;
	private wetGainNode: GainNode | null = null;
	private dryGainNode: GainNode | null = null;
	private outputNode: GainNode | null = null;
	private isConnected = false;
	private audioElement: HTMLAudioElement | null = null;
	private isInitialized = false;

	private effects: AudioEffects = {
		enabled: false,
		eq: { bands: [
			{ frequency: 60, gain: 0, q: 1 },
			{ frequency: 230, gain: 0, q: 1 },
			{ frequency: 910, gain: 0, q: 1 },
			{ frequency: 3600, gain: 0, q: 1 },
			{ frequency: 8000, gain: 0, q: 1 },
			{ frequency: 14000, gain: 0, q: 1 }
		]},
		compressor: {
			threshold: -24,
			ratio: 4,
			attack: 0.003,
			release: 0.25,
			knee: 10
		},
		reverb: {
			enabled: false,
			wetDry: 0.3
		},
		highPass: {
			enabled: false,
			frequency: 80
		},
		volumeBoost: {
			enabled: false,
			gain: 0
		},
		preset: 'flat'
	};

	async initialize(audioElement: HTMLAudioElement): Promise<void> {
		if (this.isInitialized) return;

		this.audioElement = audioElement;
		this.audioContext = new AudioContext();

		// Create source node from audio element
		this.sourceNode = this.audioContext.createMediaElementSource(audioElement);

		// Create gain nodes
		this.gainNode = this.audioContext.createGain();
		this.outputNode = this.audioContext.createGain();
		this.wetGainNode = this.audioContext.createGain();
		this.dryGainNode = this.audioContext.createGain();

		// Create volume boost node (final gain stage)
		this.volumeBoostNode = this.audioContext.createGain();
		this.updateVolumeBoost();

		// Create EQ nodes (6-band parametric EQ)
		this.eqNodes = this.effects.eq.bands.map((band, index) => {
			const filter = this.audioContext!.createBiquadFilter();
			if (index === 0) {
				filter.type = 'lowshelf';
			} else if (index === this.effects.eq.bands.length - 1) {
				filter.type = 'highshelf';
			} else {
				filter.type = 'peaking';
			}
			filter.frequency.value = band.frequency;
			filter.gain.value = band.gain;
			filter.Q.value = band.q;
			return filter;
		});

		// Create compressor
		this.compressorNode = this.audioContext.createDynamicsCompressor();
		this.updateCompressor();

		// Create high-pass filter
		this.highPassNode = this.audioContext.createBiquadFilter();
		this.highPassNode.type = 'highpass';
		this.highPassNode.frequency.value = this.effects.highPass.frequency;

		// Create convolver for reverb (impulse response will be loaded separately)
		this.convolverNode = this.audioContext.createConvolver();
		await this.loadReverbImpulse();

		// Connect bypass chain (when effects disabled)
		this.sourceNode.connect(this.audioContext.destination);
		this.isConnected = false;
		this.isInitialized = true;
	}

	private async loadReverbImpulse(): Promise<void> {
		if (!this.audioContext || !this.convolverNode) return;

		// Generate a simple reverb impulse response
		const duration = 2;
		const decay = 2;
		const sampleRate = this.audioContext.sampleRate;
		const length = sampleRate * duration;
		const impulse = this.audioContext.createBuffer(2, length, sampleRate);

		for (let channel = 0; channel < 2; channel++) {
			const channelData = impulse.getChannelData(channel);
			for (let i = 0; i < length; i++) {
				channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
			}
		}

		this.convolverNode.buffer = impulse;
	}

	enable(): void {
		if (!this.audioContext || !this.sourceNode || this.effects.enabled) return;

		// Disconnect bypass
		this.sourceNode.disconnect();

		// Build effect chain
		let currentNode: AudioNode = this.sourceNode;

		// High-pass filter (if enabled)
		if (this.effects.highPass.enabled && this.highPassNode) {
			currentNode.connect(this.highPassNode);
			currentNode = this.highPassNode;
		}

		// EQ chain
		for (const eqNode of this.eqNodes) {
			currentNode.connect(eqNode);
			currentNode = eqNode;
		}

		// Compressor
		if (this.compressorNode) {
			currentNode.connect(this.compressorNode);
			currentNode = this.compressorNode;
		}

		// Reverb (parallel wet/dry)
		if (this.effects.reverb.enabled && this.convolverNode && this.wetGainNode && this.dryGainNode && this.outputNode) {
			// Dry path
			currentNode.connect(this.dryGainNode);
			this.dryGainNode.connect(this.outputNode);

			// Wet path (through convolver)
			currentNode.connect(this.convolverNode);
			this.convolverNode.connect(this.wetGainNode);
			this.wetGainNode.connect(this.outputNode);

			currentNode = this.outputNode;
		} else if (this.outputNode) {
			currentNode.connect(this.outputNode);
			currentNode = this.outputNode;
		}

		// Volume boost (final stage before destination)
		if (this.volumeBoostNode) {
			currentNode.connect(this.volumeBoostNode);
			this.volumeBoostNode.connect(this.audioContext.destination);
		} else {
			currentNode.connect(this.audioContext.destination);
		}

		this.effects.enabled = true;
		this.isConnected = true;
	}

	disable(): void {
		if (!this.audioContext || !this.sourceNode || !this.effects.enabled) return;

		// Disconnect everything
		this.sourceNode.disconnect();
		this.eqNodes.forEach(node => node.disconnect());
		this.compressorNode?.disconnect();
		this.highPassNode?.disconnect();
		this.convolverNode?.disconnect();
		this.wetGainNode?.disconnect();
		this.dryGainNode?.disconnect();
		this.outputNode?.disconnect();
		this.volumeBoostNode?.disconnect();

		// Connect bypass
		this.sourceNode.connect(this.audioContext.destination);

		this.effects.enabled = false;
		this.isConnected = false;
	}

	toggle(): void {
		if (this.effects.enabled) {
			this.disable();
		} else {
			this.enable();
		}
	}

	setEQBand(index: number, gain: number): void {
		if (index >= 0 && index < this.eqNodes.length) {
			this.effects.eq.bands[index].gain = gain;
			this.eqNodes[index].gain.value = gain;
			this.effects.preset = 'custom';
		}
	}

	setEQPreset(preset: EffectPreset): void {
		const gains = PRESET_EQ[preset];
		gains.forEach((gain, index) => {
			if (index < this.eqNodes.length) {
				this.effects.eq.bands[index].gain = gain;
				this.eqNodes[index].gain.value = gain;
			}
		});
		this.effects.preset = preset;
	}

	private updateCompressor(): void {
		if (!this.compressorNode) return;
		const { threshold, ratio, attack, release, knee } = this.effects.compressor;
		this.compressorNode.threshold.value = threshold;
		this.compressorNode.ratio.value = ratio;
		this.compressorNode.attack.value = attack;
		this.compressorNode.release.value = release;
		this.compressorNode.knee.value = knee;
	}

	setCompressorThreshold(value: number): void {
		this.effects.compressor.threshold = value;
		if (this.compressorNode) {
			this.compressorNode.threshold.value = value;
		}
	}

	setCompressorRatio(value: number): void {
		this.effects.compressor.ratio = value;
		if (this.compressorNode) {
			this.compressorNode.ratio.value = value;
		}
	}

	setReverbEnabled(enabled: boolean): void {
		this.effects.reverb.enabled = enabled;
		if (this.effects.enabled) {
			// Reconnect chain to apply changes
			this.disable();
			this.enable();
		}
	}

	setReverbWetDry(value: number): void {
		this.effects.reverb.wetDry = value;
		if (this.wetGainNode && this.dryGainNode) {
			this.wetGainNode.gain.value = value;
			this.dryGainNode.gain.value = 1 - value;
		}
	}

	setHighPassEnabled(enabled: boolean): void {
		this.effects.highPass.enabled = enabled;
		if (this.effects.enabled) {
			this.disable();
			this.enable();
		}
	}

	setHighPassFrequency(frequency: number): void {
		this.effects.highPass.frequency = frequency;
		if (this.highPassNode) {
			this.highPassNode.frequency.value = frequency;
		}
	}

	private updateVolumeBoost(): void {
		if (!this.volumeBoostNode) return;
		// Convert dB to linear gain: gain = 10^(dB/20)
		const dbGain = this.effects.volumeBoost.enabled ? this.effects.volumeBoost.gain : 0;
		this.volumeBoostNode.gain.value = Math.pow(10, dbGain / 20);
	}

	setVolumeBoostEnabled(enabled: boolean): void {
		this.effects.volumeBoost.enabled = enabled;
		this.updateVolumeBoost();
	}

	setVolumeBoostGain(gain: number): void {
		// Clamp gain to 0-12 dB range
		this.effects.volumeBoost.gain = Math.max(0, Math.min(12, gain));
		this.updateVolumeBoost();
	}

	getEffects(): AudioEffects {
		return { ...this.effects };
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	isEnabled(): boolean {
		return this.effects.enabled;
	}

	destroy(): void {
		this.disable();
		this.audioContext?.close();
		this.audioContext = null;
		this.sourceNode = null;
		this.isInitialized = false;
	}
}

export const audioEffects = new AudioEffectsChain();
