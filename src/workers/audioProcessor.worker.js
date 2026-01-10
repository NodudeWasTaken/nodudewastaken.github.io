// This file will run in a Web Worker, so it needs to import functions directly.

// Helper functions for DSP
// Changed: Accepts channelData (Float32Array) instead of AudioBuffer
function getRMS(channelData, frameLength, hopLength) {
    const rmsValues = [];
    // const channelData = buffer.getChannelData(0); // No longer needed

    for (let i = 0; i <= channelData.length - frameLength; i += hopLength) {
        let sumSq = 0;
        for (let j = 0; j < frameLength; j++) {
            sumSq += channelData[i + j] * channelData[i + j];
        }
        rmsValues.push(Math.sqrt(sumSq / frameLength));
    }
    return rmsValues;
}

// Changed: Accepts channelData (Float32Array) and sr (sampleRate) instead of AudioBuffer
function getPitch(channelData, sr, hopLength) {
    // This is a VERY simplified pitch estimation using autocorrelation.
    // It will not be as robust or accurate as librosa.piptrack.
    // librosa.piptrack returns multiple pitch candidates and their magnitudes.
    // Here, we aim for a single dominant fundamental frequency.

    const pitchValues = [];
    // const channelData = buffer.getChannelData(0); // No longer needed
    const minFreq = 50; // Hz, roughly C2
    const maxFreq = 1000; // Hz, roughly B5
    const minPeriod = sr / maxFreq; // Corresponds to maxFreq
    const maxPeriod = sr / minFreq; // Corresponds to minFreq

    for (let i = 0; i <= channelData.length - hopLength; i += hopLength) {
        const frame = channelData.slice(i, i + hopLength);
        if (frame.length < hopLength) break; // Should not happen with adjusted loop condition

        let bestPitch = 0.01; // Default to a small non-zero value
        
        // Simple autocorrelation for pitch detection
        let autoCorr = new Array(hopLength).fill(0);
        for (let lag = 0; lag < hopLength; lag++) {
            for (let j = 0; j < hopLength - lag; j++) {
                autoCorr[lag] += frame[j] * frame[j + lag];
            }
        }

        // Find the peak in autocorrelation within the valid period range
        let peakValue = 0; // Initialize to find maximum correlation
        let peakLag = 0;
        // Search for peak, excluding lag 0 (DC offset or max correlation with self)
        // Start from Math.floor(minPeriod) + 1 to avoid short periods if minPeriod is 0 or 1
        const startLag = Math.max(2, Math.floor(minPeriod)); // Minimum lag of 2 to avoid trivial peaks
        const endLag = Math.min(hopLength - 1, Math.ceil(maxPeriod)); // Ensure within frame bounds

        for (let lag = startLag; lag < endLag; lag++) {
            if (autoCorr[lag] > peakValue) {
                peakValue = autoCorr[lag];
                peakLag = lag;
            }
        }
        
        // Check if a meaningful peak was found
        if (peakLag > 0) { // Ensure peakLag is valid
            bestPitch = sr / peakLag;
        }

        // Clamp values to prevent issues (similar to librosa.fmax)
        pitchValues.push(Math.max(0.01, bestPitch));
    }
    return pitchValues;
}

function framesToTime(numFrames, sr, hopLength) {
    const times = [];
    for (let i = 0; i < numFrames; i++) {
        times.push(i * hopLength / sr);
    }
    return times;
}

function getBeats(rmsValues, sr, hopLength, audioDuration) {
    // This is a VERY simplified beat tracking.
    // librosa uses onset detection functions (ODF) and dynamic programming for beat tracking.
    // Here, we just find peaks in the RMS values as a proxy for "beats".
    // This will NOT yield librosa-quality beat tracking.

    const beats = [];
    const frameTimes = framesToTime(rmsValues.length, sr, hopLength);

    // Thresholding and simple peak picking
    let maxRMS = 0;
	// Math.max causes max callstack errors in big input.
    if (rmsValues.length > 0) {
        maxRMS = rmsValues[0];
        for (let i = 1; i < rmsValues.length; i++) {
            if (rmsValues[i] > maxRMS) {
                maxRMS = rmsValues[i];
            }
        }
    }
    const threshold = 0.2 * maxRMS; // Adjust threshold as needed
    const minBeatInterval = 0.3; // Minimum time between beats in seconds (approx 200 BPM)

    let lastPeakTime = -Infinity;

    for (let i = 1; i < rmsValues.length - 1; i++) {
        // Check if current RMS is a local maximum and above threshold
        if (rmsValues[i] > threshold && rmsValues[i] > rmsValues[i - 1] && rmsValues[i] > rmsValues[i + 1]) {
            const currentTime = frameTimes[i];
            if (currentTime - lastPeakTime > minBeatInterval) {
                beats.push(currentTime);
                lastPeakTime = currentTime;
            }
        }
    }
    
    // The original Python code `librosa.beat.beat_track` with `trim=False`
    // means it can produce beats slightly beyond the audio duration if a tempo continues.
    // We'll keep the beats as found and rely on the UI rendering to handle display bounds.

    return beats;
}

self.onmessage = async (event) => {
    const { type, payload } = event.data;

    if (type === 'processAudio') {
        // Changed: Receive raw channelData, sampleRate, and duration instead of AudioBuffer
        const { channelData, sampleRate, duration, hopLength, frameLength, plp } = payload;
        
        try {
            self.postMessage({ type: 'progress', value: 10, message: 'Processing RMS...' });
            // Changed: Pass channelData directly
            const rms = getRMS(channelData, frameLength, hopLength);

            self.postMessage({ type: 'progress', value: 40, message: 'Processing Pitch...' });
            // Changed: Pass channelData and sampleRate directly
            const pitches = getPitch(channelData, sampleRate, hopLength);

            // Adjust arrays to be of similar length, or truncate to shortest.
            // Python's librosa outputs different lengths for features.
            // For simplicity, truncate all to minimum length after processing.
            const minLength = Math.min(rms.length, pitches.length);
            const truncatedRms = rms.slice(0, minLength);
            const truncatedPitches = pitches.slice(0, minLength);

            // Compute beats (simplified)
            self.postMessage({ type: 'progress', value: 70, message: 'Processing Beats...' });
            // Changed: Pass sampleRate and duration directly
            const beats = getBeats(truncatedRms, sampleRate, hopLength, duration);

            // Compute frames times
            const frames = framesToTime(truncatedRms.length, sampleRate, hopLength);

            // Compute splits like in Python
            const splits = [0];
            let last = 0;
            for (let k = 0; k < frames.length; k++) {
                if (last >= beats.length) break;
                if (frames[k] > beats[last]) {
                    if (last > 0) {
                        splits.push(k);
                    }
                    last++;
                }
            }
            splits.push(-1);

            // Compute fpitch and frms
            const fpitch = [];
            const frms = [];
            for (let i = 1; i < splits.length; i++) {
                const start = splits[i - 1];
                const end = splits[i] === -1 ? truncatedPitches.length : splits[i];
                let sumPitch = 0;
                let sumRms = 0;
                for (let j = start; j < end; j++) {
                    sumPitch += truncatedPitches[j];
                    sumRms += truncatedRms[j];
                }
                fpitch.push(sumPitch);
                frms.push(sumRms);
            }

            // Log the pitch
            const logPitch = fpitch.map(p => Math.log10(Math.max(0.01, p)));

            self.postMessage({ type: 'progress', value: 90, message: 'Collecting results...' });

            self.postMessage({
                type: 'audioDataReady',
                data: {
                    at: duration, // Use the passed duration
                    beats: beats,
                    pitch: logPitch,
                    energy: frms
                }
            });
        } catch (error) {
            console.error("Audio processing worker failed:", error);
            self.postMessage({ type: 'error', message: error.message });
        }
    }
};
