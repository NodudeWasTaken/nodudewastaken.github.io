import { useState, useEffect, useRef, useCallback } from 'react';
import { create_actions, speed, dumpFunscript } from '../lib/utils'; // Assuming these are now in lib/utils.js
import { HEATMAP_COLORS } from '../lib/constants'; // For render_heatmap

// Dynamically import the worker URL for Vite/Webpack
import AudioProcessorWorker from '../workers/audioProcessor.worker?worker';

// Helper for render_heatmap in JS (using Canvas)
export function render_heatmap_js(data, energy_multiplier, pitch_range, overflow, width, height, amplitude_centering = 0, center_offset = 0) {
    const result = create_actions(data, parseFloat(energy_multiplier), parseFloat(pitch_range), parseFloat(overflow), parseFloat(amplitude_centering), parseFloat(center_offset));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Set dark background to match the main canvas
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    if (result.length < 2) {
        return canvas;
    }

    const speeds = [];
    for (let i = 0; i < result.length - 1; i++) {
        speeds.push(speed(result[i], result[i + 1]));
    }
    
    // Normalize speeds to 0-1 for color mapping
    const normalizedSpeeds = speeds.length > 0 ? speeds.map(s => Math.min(1, Math.max(0, s))) : [];

    const colorMap = (value) => {
        // Simple linear interpolation for heatmap colors
        // From ["w", "g", "orange", "r"] - 0, 0.33, 0.66, 1
        // HEATMAP = LinearSegmentedColormap.from_list("intensity",["w", "g", "orange", "r"], N=256)
        // This is a rough approximation of matplotlib's LinearSegmentedColormap
        const r = [255, 0, 255, 255]; // R, G, Orange, R
        const g = [255, 128, 165, 0];
        const b = [255, 0, 0, 0];

        const steps = [0, 0.33, 0.66, 1.0]; // Approximated steps for white, green, orange, red
        
        let c1_idx = 0;
        let c2_idx = 0;
        let t = 0;

        if (value <= steps[0]) {
            c1_idx = 0; c2_idx = 0; t = 0;
        } else if (value >= steps[steps.length - 1]) {
            c1_idx = steps.length - 1; c2_idx = steps.length - 1; t = 1;
        } else {
            for (let i = 0; i < steps.length - 1; i++) {
                if (value >= steps[i] && value <= steps[i + 1]) {
                    c1_idx = i;
                    c2_idx = i + 1;
                    t = (value - steps[i]) / (steps[i + 1] - steps[i]);
                    break;
                }
            }
        }

        const interpolate = (start, end, t_val) => Math.round(start + (end - start) * t_val);

        const red = interpolate(r[c1_idx], r[c2_idx], t);
        const green = interpolate(g[c1_idx], g[c2_idx], t);
        const blue = interpolate(b[c1_idx], b[c2_idx], t);
        
        return `rgb(${red},${green},${blue})`;
    };

    // Draw the funscript result as a line graph with colors based on speeds
    if (result.length > 0) {
        // Calculate duration for horizontal scaling
        const duration = data.at || (result[result.length - 1]?.at + 1) || 1; 
        const effectiveDuration = duration > 0 ? duration : 1; 

        for (let i = 0; i < result.length - 1; i++) {
            const color = colorMap(normalizedSpeeds[i]);
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;

            const x1 = (result[i].at / effectiveDuration) * width;
            const y1 = height - (result[i].pos / 100) * height;
            const x2 = (result[i + 1].at / effectiveDuration) * width;
            const y2 = height - (result[i + 1].pos / 100) * height;

            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
    }

    return canvas;
}

// Hook to manage audio processing and rendering logic
export function useAudioProcessor() {
    const [audioData, setAudioData] = useState({}); // {at, beats, pitch, energy}
    const [funscriptResult, setFunscriptResult] = useState([]); // [{at, pos}, ...]
    const [progress, setProgress] = useState({ value: 0, message: 'Ready' });
    const [isLoading, setIsLoading] = useState(false);
    const [isRendering, setIsRendering] = useState(false);

    const audioCtxRef = useRef(null);
    const workerRef = useRef(null);

    // Initialize Web Audio Context and Worker
    useEffect(() => {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        
        workerRef.current = new AudioProcessorWorker();
        workerRef.current.onmessage = (event) => {
            const { type, value, message, data, error } = event.data;
            if (type === 'progress') {
                setProgress({ value, message });
                if (value === -1) setIsLoading(false); // Error state
            } else if (type === 'audioDataReady') {
                setAudioData(data);
                setIsLoading(false);
                setProgress({ value: 100, message: 'Audio data loaded!' });
            } else if (type === 'error') {
                console.error("Worker error:", error || message);
                setProgress({ value: -1, message: error || message });
                setIsLoading(false);
            }
        };
        workerRef.current.onerror = (e) => {
            console.error("Worker encountered an error:", e);
            setProgress({ value: -1, message: `Worker error: ${e.message}` });
            setIsLoading(false);
        };

        return () => {
            if (workerRef.current) {
                workerRef.current.terminate();
            }
            if (audioCtxRef.current) {
                audioCtxRef.current.close();
            }
        };
    }, []);

    const processAudioFile = useCallback(async (file) => {
        if (!file) return;

        setIsLoading(true);
        setProgress({ value: 0, message: 'Loading audio...' });

        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer);

            // Extract the Float32Array from the AudioBuffer
            // We'll assume mono for simplicity based on the worker's current implementation
            const channelData = audioBuffer.getChannelData(0); 
            const sampleRate = audioBuffer.sampleRate;
            const duration = audioBuffer.duration;

            // Post the raw audio data and metadata to the worker
            workerRef.current.postMessage({
                type: 'processAudio',
                payload: {
                    channelData: channelData, // This is a Float32Array
                    sampleRate: sampleRate,
                    duration: duration,
                    hopLength: 1024,
                    frameLength: 1024,
                    plp: false,
                }
            }, [channelData.buffer]); // Pass the underlying ArrayBuffer for transfer
                                      // Note: channelData itself is a TypedArray view, 
                                      // its underlying buffer needs to be transferred.
        } catch (error) {
            console.error("Failed to load or decode audio:", error);
            setProgress({ value: -1, message: `Failed to load audio: ${error.message}` });
            setIsLoading(false);
        }
    }, []);

    const generateFunscriptActions = useCallback((currentAudioData, energyMult, pitchRange, overflowMode, amplitudeCentering = 0, centerOffset = 0) => {
        if (Object.keys(currentAudioData).length === 0) {
            setFunscriptResult([]);
            return;
        }

        setIsRendering(true);
        setProgress({ value: 0, message: 'Generating actions...' });

        try {
            const actions = create_actions(
                currentAudioData,
                parseFloat(energyMult),
                parseFloat(pitchRange),
                parseFloat(overflowMode),
                parseFloat(amplitudeCentering),
                parseFloat(centerOffset)
            );
            setFunscriptResult(actions);
            setProgress({ value: 100, message: 'Actions generated!' });
        } catch (error) {
            console.error("Failed to generate funscript actions:", error);
            setProgress({ value: -1, message: `Action generation error: ${error.message}` });
            setFunscriptResult([]);
        } finally {
            setIsRendering(false);
        }
    }, []);

    return {
        audioData,
        funscriptResult,
        progress,
        isLoading,
        isRendering,
        processAudioFile,
        generateFunscriptActions,
        render_heatmap_js,
    };
}
