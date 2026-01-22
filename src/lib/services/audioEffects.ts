import { browser } from '$app/environment';
import type { AudioEffects, EffectPreset } from '$lib/types';

const PRESET_EQ: Record<EffectPreset, number[]> = {
	flat: [0, 0, 0, 0, 0, 0],
	dialog: [0, 3, 6, 4, 2, 0],    // Boost mids for speech clarity
	bass: [6, 4, 0, 0, 0, 0],      // Boost low frequencies
	treble: [0, 0, 0, 2, 4, 6],    // Boost high frequencies
	custom: [0, 0, 0, 0, 0, 0]
};

const STORAGE_KEY = 'ecobox-audio-effects';

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
	private webAudioConnected = false; // Track if we've connected to Web Audio API

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

	private saveToStorage(): void {
		if (!browser) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.effects));
		} catch {
			// Ignore storage errors
		}
	}

	private loadFromStorage(): void {
		if (!browser) return;
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as Partial<AudioEffects>;
				// Merge with defaults to handle new properties
				if (parsed.enabled !== undefined) this.effects.enabled = parsed.enabled;
				if (parsed.eq?.bands) this.effects.eq.bands = parsed.eq.bands;
				if (parsed.compressor) this.effects.compressor = { ...this.effects.compressor, ...parsed.compressor };
				if (parsed.reverb) this.effects.reverb = { ...this.effects.reverb, ...parsed.reverb };
				if (parsed.highPass) this.effects.highPass = { ...this.effects.highPass, ...parsed.highPass };
				if (parsed.volumeBoost) this.effects.volumeBoost = { ...this.effects.volumeBoost, ...parsed.volumeBoost };
				if (parsed.preset) this.effects.preset = parsed.preset;
			}
		} catch {
			// Ignore parse errors, use defaults
		}
	}

	// Detect iOS (iPhone, iPad, iPod)
	isIOS(): boolean {
		if (!browser) return false;
		// Check userAgent for iOS devices
		if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
		// iPad on iOS 13+ reports as Mac, detect via touch support
		if (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) return true;
		return false;
	}

	// Check if Web Audio has been connected (effects have been enabled at least once)
	isWebAudioConnected(): boolean {
		return this.webAudioConnected;
	}

	async initialize(audioElement: HTMLAudioElement): Promise<void> {
		if (this.isInitialized) return;

		// Load saved settings before creating nodes
		this.loadFromStorage();
		const shouldEnable = this.effects.enabled;
		this.effects.enabled = false; // Reset so enable() will work

		this.audioElement = audioElement;
		this.isInitialized = true;

		// On iOS, don't auto-enable effects to preserve background playback
		// User must explicitly enable effects (with warning shown in UI)
		if (this.isIOS()) {
			// Don't connect to Web Audio API yet - audio plays directly
			return;
		}

		// On non-iOS, enable effects if they were saved as enabled
		if (shouldEnable) {
			await this.connectWebAudio();
			this.enable();
		}
	}

	// Create Web Audio nodes and connect the audio element
	// Once called, audio is permanently routed through Web Audio API
	private async connectWebAudio(): Promise<void> {
		if (this.webAudioConnected || !this.audioElement) return;

		this.audioContext = new AudioContext();

		// Resume AudioContext on user interaction (required by browsers)
		if (this.audioContext.state === 'suspended') {
			const resumeContext = async () => {
				await this.audioContext?.resume();
				document.removeEventListener('click', resumeContext);
				document.removeEventListener('keydown', resumeContext);
			};
			document.addEventListener('click', resumeContext, { once: true });
			document.addEventListener('keydown', resumeContext, { once: true });
		}

		// Create source node from audio element
		// WARNING: Once connected, audio element is permanently routed through AudioContext
		this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);

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
		this.webAudioConnected = true;
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

	async enable(): Promise<void> {
		if (this.effects.enabled) return;

		// Connect to Web Audio API if not already connected
		if (!this.webAudioConnected) {
			await this.connectWebAudio();
		}

		if (!this.audioContext || !this.sourceNode) return;

		// Disconnect bypass
		this.sourceNode.disconnect();

		// Build effect chain - all effects always connected
		// Individual effects are bypassed via their parameters
		let currentNode: AudioNode = this.sourceNode;

		// High-pass filter (always connected, bypassed via low frequency when disabled)
		if (this.highPassNode) {
			currentNode.connect(this.highPassNode);
			currentNode = this.highPassNode;
			// Set to 1Hz (effectively bypass) if disabled, or actual frequency if enabled
			this.highPassNode.frequency.value = this.effects.highPass.enabled
				? this.effects.highPass.frequency
				: 1;
		}

		// EQ chain (always connected)
		for (const eqNode of this.eqNodes) {
			currentNode.connect(eqNode);
			currentNode = eqNode;
		}

		// Compressor (always connected)
		if (this.compressorNode) {
			currentNode.connect(this.compressorNode);
			currentNode = this.compressorNode;
		}

		// Reverb (always connected as parallel wet/dry, bypassed via wet=0 when disabled)
		if (this.convolverNode && this.wetGainNode && this.dryGainNode && this.outputNode) {
			// Dry path
			currentNode.connect(this.dryGainNode);
			this.dryGainNode.connect(this.outputNode);

			// Wet path (through convolver)
			currentNode.connect(this.convolverNode);
			this.convolverNode.connect(this.wetGainNode);
			this.wetGainNode.connect(this.outputNode);

			// Set wet/dry mix based on enabled state
			if (this.effects.reverb.enabled) {
				this.wetGainNode.gain.value = this.effects.reverb.wetDry;
				this.dryGainNode.gain.value = 1 - this.effects.reverb.wetDry;
			} else {
				this.wetGainNode.gain.value = 0;
				this.dryGainNode.gain.value = 1;
			}

			currentNode = this.outputNode;
		}

		// Volume boost (always connected, final stage)
		if (this.volumeBoostNode) {
			currentNode.connect(this.volumeBoostNode);
			this.volumeBoostNode.connect(this.audioContext.destination);
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

	async toggle(): Promise<void> {
		if (this.effects.enabled) {
			this.disable();
		} else {
			await this.enable();
		}
		this.saveToStorage();
	}

	setEQBand(index: number, gain: number): void {
		if (index >= 0 && index < this.eqNodes.length) {
			this.effects.eq.bands[index].gain = gain;
			this.eqNodes[index].gain.value = gain;
			this.effects.preset = 'custom';
			this.saveToStorage();
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
		this.saveToStorage();
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
		this.saveToStorage();
	}

	setCompressorRatio(value: number): void {
		this.effects.compressor.ratio = value;
		if (this.compressorNode) {
			this.compressorNode.ratio.value = value;
		}
		this.saveToStorage();
	}

	setReverbEnabled(enabled: boolean): void {
		this.effects.reverb.enabled = enabled;
		// Update wet/dry mix instead of rebuilding chain
		if (this.wetGainNode && this.dryGainNode) {
			if (enabled) {
				this.wetGainNode.gain.value = this.effects.reverb.wetDry;
				this.dryGainNode.gain.value = 1 - this.effects.reverb.wetDry;
			} else {
				this.wetGainNode.gain.value = 0;
				this.dryGainNode.gain.value = 1;
			}
		}
		this.saveToStorage();
	}

	setReverbWetDry(value: number): void {
		this.effects.reverb.wetDry = value;
		if (this.wetGainNode && this.dryGainNode && this.effects.reverb.enabled) {
			this.wetGainNode.gain.value = value;
			this.dryGainNode.gain.value = 1 - value;
		}
		this.saveToStorage();
	}

	setHighPassEnabled(enabled: boolean): void {
		this.effects.highPass.enabled = enabled;
		// Update frequency instead of rebuilding chain (1Hz = effectively bypassed)
		if (this.highPassNode) {
			this.highPassNode.frequency.value = enabled ? this.effects.highPass.frequency : 1;
		}
		this.saveToStorage();
	}

	setHighPassFrequency(frequency: number): void {
		this.effects.highPass.frequency = frequency;
		if (this.highPassNode && this.effects.highPass.enabled) {
			this.highPassNode.frequency.value = frequency;
		}
		this.saveToStorage();
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
		this.saveToStorage();
	}

	setVolumeBoostGain(gain: number): void {
		// Clamp gain to 0-12 dB range
		this.effects.volumeBoost.gain = Math.max(0, Math.min(12, gain));
		this.updateVolumeBoost();
		this.saveToStorage();
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

	async resumeContext(): Promise<void> {
		if (this.audioContext?.state === 'suspended') {
			await this.audioContext.resume();
		}
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
