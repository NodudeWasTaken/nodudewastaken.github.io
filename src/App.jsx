import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAudioProcessor, render_heatmap_js } from './hooks/useAudioProcessor';
import { dumpFunscript, speed, normalize } from './lib/utils';
import { VERSION } from './lib/constants';
import './App.css'; // For basic styling

// Config utility using localStorage
const Config = (() => {
    const data = {};
    const configName = "pythondancer_config";

    if (localStorage.getItem(configName)) {
        try {
            Object.assign(data, JSON.parse(localStorage.getItem(configName)));
        } catch (e) {
            console.error("Failed to parse config from localStorage:", e);
            localStorage.removeItem(configName); // Clear corrupted config
        }
    }

    const save = (name, val) => {
        data[name] = val;
        localStorage.setItem(configName, JSON.stringify(data));
    };

    const get = (name, defaultValue) => {
        return name in data ? data[name] : defaultValue;
    };

    return { save, get };
})();

function App() {
    const {
        audioData,
        funscriptResult,
        progress,
        isLoading,
        isRendering,
        processAudioFile,
        generateFunscriptActions,
        autoTuneParameters,
    } = useAudioProcessor();

    const [fileName, setFileName] = useState(null);
    const [currentAudioFile, setCurrentAudioFile] = useState(null);

    // Settings state
    const [pitchRange, setPitchRange] = useState(Config.get("pitch", 20));
    const [energyMultiplier, setEnergyMultiplier] = useState(Config.get("energy", 10));
    const [overflowMode, setOverflowMode] = useState(Config.get("OOR", "crop")); // 0: crop, 1: bounce, 2: fold
    const [showHeatmap, setShowHeatmap] = useState(Config.get("heatmap", true));

    const [autoMap, setAutoMap] = useState(Config.get("automap", true));
    const [autoMapMode, setAutoMapMode] = useState(Config.get("automode", "meanv2")); // 0: mean, 1: meanv2, 2: length
    const [targetSpeed, setTargetSpeed] = useState(Config.get("tspeed", 250));
    const [targetPitch, setTargetPitch] = useState(Config.get("tpitch", 20));
    const [targetPercentage, setTargetPercentage] = useState(Config.get("tper", 65));

    const audioInputCanvasRef = useRef(null);
    const audioOutputCanvasRef = useRef(null);
    // Removed unused refs: settingsGroupRef, automapGroupRef

    const oorMap = { "crop": 0, "bounce": 1, "fold": 2 };
    const automapModeMap = { "mean": 0, "meanv2": 1, "length": 2 };

    // Update funscript actions when settings or audio data changes
    useEffect(() => {
        generateFunscriptActions(audioData, energyMultiplier / 10.0, pitchRange, oorMap[overflowMode]);
    }, [audioData, energyMultiplier, pitchRange, overflowMode, generateFunscriptActions]);

    // Handle auto-mapping
    useEffect(() => {
        if (autoMap && Object.keys(audioData).length > 0) {
            const { pitch, energy } = autoTuneParameters(
                audioData,
                targetPitch,
                targetSpeed,
                targetPercentage / 100.0,
                automapModeMap[autoMapMode]
            );
            // console.log("Auto-tuned:", {pitch, energy});
            setPitchRange(Math.round(pitch));
            setEnergyMultiplier(Math.round(energy * 10.0));
        }
    }, [autoMap, audioData, targetPitch, targetSpeed, targetPercentage, autoMapMode, autoTuneParameters]);

    // Draw audio input graph
    useEffect(() => {
        const canvas = audioInputCanvasRef.current;
        // Only draw if canvas and necessary audio data are available
        if (!canvas || !audioData.pitch || audioData.pitch.length === 0 || !audioData.energy || audioData.energy.length === 0) {
            return;
        }

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        
        // Set canvas's actual drawing buffer size for crisp rendering
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
        ctx.scale(dpr, dpr); // Scale context to match DPR

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1a1a1a'; // Match CSS background for graph area
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // --- Visualization Ranges (Fixed for consistent display) ---
        const LOG_PITCH_MIN = Math.log10(50);   // log10(Hz), lower bound for visualization
        const LOG_PITCH_MAX = Math.log10(1000); // log10(Hz), upper bound for visualization
        const ENERGY_MIN = 0.0;    // Min normalized energy
        const ENERGY_MAX = 1.0;    // Max normalized energy

        // Helper to map a value from its range to canvas Y-coordinate (inverted)
        const mapValueToCanvasY = (value, minVal, maxVal, canvasHeight) => {
            const clampedValue = Math.max(minVal, Math.min(maxVal, value));
            const normalized = (clampedValue - minVal) / (maxVal - minVal);
            return canvasHeight - (normalized * canvasHeight);
        };

        // Helper to map a log pitch to canvas Y-coordinate
        const mapLogPitchToCanvasY = (logPitch, minLog, maxLog, canvasHeight) => {
            const clamped = Math.max(minLog, Math.min(maxLog, logPitch));
            const normalized = (clamped - minLog) / (maxLog - minLog);
            return canvasHeight - (normalized * canvasHeight); // Invert Y
        };

        // Draw pitch
        ctx.beginPath();
        ctx.strokeStyle = '#00ffff'; // Cyan
        ctx.lineWidth = 1;
        for (let i = 0; i < audioData.pitch.length; i++) {
            const x = (i / audioData.pitch.length) * canvas.clientWidth;
            const y = mapLogPitchToCanvasY(audioData.pitch[i], LOG_PITCH_MIN, LOG_PITCH_MAX, canvas.clientHeight);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Draw energy
        const normalizedEnergy = normalize(audioData.energy);
        ctx.beginPath();
        ctx.strokeStyle = '#00ff00'; // Lime green
        ctx.lineWidth = 1;
        for (let i = 0; i < normalizedEnergy.length; i++) {
            const x = (i / normalizedEnergy.length) * canvas.clientWidth;
            const y = mapValueToCanvasY(normalizedEnergy[i], ENERGY_MIN, ENERGY_MAX, canvas.clientHeight);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }, [audioData]); // Depend only on audioData

    // Helper for heatmap color mapping
    const colorMap = (value) => {
        // Simple linear interpolation for heatmap colors
        // From ["w", "g", "orange", "r"] - 0, 0.33, 0.66, 1
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

    // Draw funscript output graph (heatmap or actions line)
    useEffect(() => {
        const canvas = audioOutputCanvasRef.current;
        if (!canvas || funscriptResult.length === 0) {
            return;
        }

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1a1a1a'; // Match CSS background
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const duration = audioData.at || (funscriptResult[funscriptResult.length - 1]?.at + 1) || 1; // Fallback duration, prevent 0
        const effectiveDuration = duration > 0 ? duration : 1; 

        if (showHeatmap) {
            // Draw the funscript result as a line graph with colors based on speeds
            const speeds = [];
            for (let i = 0; i < funscriptResult.length - 1; i++) {
                speeds.push(speed(funscriptResult[i], funscriptResult[i + 1]));
            }
            const normalizedSpeeds = speeds.length > 0 ? speeds.map(s => Math.min(1, Math.max(0, s))) : [];

            for (let i = 0; i < funscriptResult.length - 1; i++) {
                const color = colorMap(normalizedSpeeds[i]);
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;

                const x1 = (funscriptResult[i].at / effectiveDuration) * canvas.clientWidth;
                const y1 = canvas.clientHeight - (funscriptResult[i].pos / 100) * canvas.clientHeight;
                const x2 = (funscriptResult[i + 1].at / effectiveDuration) * canvas.clientWidth;
                const y2 = canvas.clientHeight - (funscriptResult[i + 1].pos / 100) * canvas.clientHeight;

                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        } else {
            ctx.beginPath();
            ctx.strokeStyle = '#ee00ee'; // A vibrant purple
            ctx.lineWidth = 1.5;
            funscriptResult.forEach((action, i) => {
                const x = (action.at / effectiveDuration) * canvas.clientWidth;
                const y = canvas.clientHeight - (action.pos / 100) * canvas.clientHeight; // Invert Y for canvas
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        }
    }, [funscriptResult, audioData, showHeatmap, energyMultiplier, pitchRange, overflowMode]); // Depend on all relevant states

    // Compute stats for the funscript
    const stats = useMemo(() => {
        if (funscriptResult.length === 0) return null;

        const numActions = funscriptResult.length;
        const duration = audioData.at || (funscriptResult[funscriptResult.length - 1]?.at / 1000) || 0; // in seconds

        const speeds = [];
        for (let i = 0; i < funscriptResult.length - 1; i++) {
            const a = funscriptResult[i];
            const b = funscriptResult[i + 1];
            const dt = b.at - a.at; // at is in seconds
            if (dt > 0) {
                const speed = Math.abs(b.pos - a.pos) / dt;
                speeds.push(speed);
            }
        }

        const avgSpeed = speeds.length > 0 ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length : 0;
        const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

        return {
            numActions,
            duration: duration.toFixed(2),
            avgSpeed: avgSpeed.toFixed(2),
            maxSpeed: maxSpeed.toFixed(2)
        };
    }, [funscriptResult, audioData.at]);

    // ... (rest of the App component remains the same) ...

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setCurrentAudioFile(file);
            setFileName(file.name);
            processAudioFile(file);
        }
    };

    const handleAboutClick = () => {
        alert(`PythonDancer JS ${VERSION}

Thanks to ncdxncdx for the original application!
Thanks to Nodude for the Python port!
Thanks to you for using this software!`);
    };

    const handleFunscriptExport = () => {
        if (funscriptResult.length === 0) {
            alert("No funscript data to export. Load audio and generate actions first.");
            return;
        }
        const jsonString = dumpFunscript(funscriptResult);
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const baseName = fileName ? fileName.split('.').slice(0, -1).join('.') : 'funscript';
        a.download = `${baseName}.funscript`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleHeatmapExport = () => {
        if (Object.keys(audioData).length === 0) {
            alert("No audio data to generate heatmap. Load audio first.");
            return;
        }

        // Fixed width/height for export
        const width = 4096; 
        const height = 128; 

        // Pass direct width/height for the exported image, not clientWidth/Height
        const heatmapCanvas = render_heatmap_js(
            audioData,
            energyMultiplier / 10.0,
            pitchRange,
            oorMap[overflowMode],
            width, height // These are the dimensions for the output canvas
        );

        const url = heatmapCanvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        const baseName = fileName ? fileName.split('.').slice(0, -1).join('.') : 'heatmap';
        a.download = `${baseName}_heatmap.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const handleSettingsChange = (setter, configKey) => (e) => {
        let val;
        if (typeof e === 'object' && e.target) { // From input/slider event
            val = e.target.value;
        } else { // Direct value (e.g., from autotune)
            val = e;
        }
        setter(val);
        Config.save(configKey, val);
    };

    const handleCheckboxChange = (setter, configKey) => (e) => {
        const val = e.target.checked;
        setter(val);
        Config.save(configKey, val);
    };

    const handleRadioChange = (setter, configKey) => (e) => {
        const val = e.target.value;
        setter(val);
        Config.save(configKey, val);
    };

    const isProcessingAny = isLoading || isRendering;

    return (
        <div className="App">
            <h1>PythonDancer JS {VERSION}</h1>

            {/* Media GroupBox */}
            <fieldset className="group-box">
                <legend>Media</legend>
                <div className="media-controls">
                    <button onClick={handleAboutClick}>About</button>
                    <label htmlFor="audio-file-input" className="load-button" disabled={isLoading}>Load</label>
                    <input
                        id="audio-file-input"
                        type="file"
                        accept="audio/*,video/*"
                        onChange={handleFileChange}
                        style={{ display: 'none' }}
                        disabled={isLoading}
                    />
                    <div className="progress-container">
                        <label className="progress-label">{progress.message}</label>
                        <progress value={progress.value} max="100"></progress>
                    </div>
                </div>
                {fileName && <p className="loaded-filename">Loaded: {fileName}</p>}
            </fieldset>

            {/* Audio Data GroupBox */}
            <fieldset className="group-box audio-data-group">
                <legend>Audio Data</legend>
                <p className="graph-label">Input Audio (Pitch: Cyan, Energy: Green, Beats: White)</p>
                <div className="audio-input-container">
                    <canvas ref={audioInputCanvasRef} className="audio-graph"></canvas>
                </div>
                <p className="graph-label">Funscript Output (Heatmap or Purple Line)</p>
                <div className="audio-output-container">
                    <canvas ref={audioOutputCanvasRef} className="audio-graph"></canvas>
                </div>
                {stats && (
                    <div className="stats-display">
                        <div>Actions: {stats.numActions}</div>
                        <div>Duration: {stats.duration}s</div>
                        <div>Avg Speed: {stats.avgSpeed} units/s</div>
                        <div>Max Speed: {stats.maxSpeed} units/s</div>
                    </div>
                )}
            </fieldset>

            {/* Settings GroupBox */}
            <fieldset className="group-box settings-group" disabled={isProcessingAny}>
                <legend>Settings</legend>
                <div className="settings-grid">
                    <div className="slider-container"> {/* Container for both vertical sliders */}
                        <div className="slider-group">
                            <label>Pitch Offset</label>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                step="1"
                                value={pitchRange}
                                onChange={handleSettingsChange(setPitchRange, "pitch")}
                                className="vertical-slider"
                            />
                            <span>{pitchRange}</span>
                        </div>

                        <div className="slider-group">
                            <label>Energy Multiplier</label>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                step="1"
                                value={energyMultiplier}
                                onChange={handleSettingsChange(setEnergyMultiplier, "energy")}
                                className="vertical-slider"
                            />
                            <span>{energyMultiplier}</span>
                        </div>
                    </div> {/* End slider-container */}

                    <div className="options-container"> {/* Container for Misc and Automap settings */}
                        <fieldset className="sub-group">
                            <legend>Out of range</legend>
                            <div>
                                <label><input type="radio" name="oor" value="crop" checked={overflowMode === "crop"} onChange={handleRadioChange(setOverflowMode, "OOR")} /> Crop</label>
                            </div>
                            <div>
                                <label><input type="radio" name="oor" value="bounce" checked={overflowMode === "bounce"} onChange={handleRadioChange(setOverflowMode, "OOR")} /> Bounce</label>
                            </div>
                            <div>
                                <label><input type="radio" name="oor" value="fold" checked={overflowMode === "fold"} onChange={handleRadioChange(setOverflowMode, "OOR")} /> Fold</label>
                            </div>
                        </fieldset>

                        <fieldset className="sub-group">
                            <legend>Misc</legend>
                            <div>
                                <label><input type="checkbox" checked={showHeatmap} onChange={handleCheckboxChange(setShowHeatmap, "heatmap")} /> Heatmap</label>
                            </div>

                            <div>
                                <label><input type="checkbox" checked={autoMap} onChange={handleCheckboxChange(setAutoMap, "automap")} disabled /> Automap</label>
                            </div>
                        </fieldset>

                        <fieldset className="sub-group automap-settings" disabled={!autoMap}>
                            <legend>Automap settings</legend>
                            <div>
                                <label><input type="radio" name="automap_mode" value="mean" checked={autoMapMode === "mean"} onChange={handleRadioChange(setAutoMapMode, "automode")} /> Mean</label>
                            </div>
                            <div>
                                <label><input type="radio" name="automap_mode" value="meanv2" checked={autoMapMode === "meanv2"} onChange={handleRadioChange(setAutoMapMode, "automode")} /> MeanV2</label>
                            </div>
                            <div>
                                <label><input type="radio" name="automap_mode" value="length" checked={autoMapMode === "length"} onChange={handleRadioChange(setAutoMapMode, "automode")} /> Length</label>
                            </div>
                            <div className="spinbox-group">
                                <label>Target Speed:</label>
                                <input
                                    type="number"
                                    min="0" max="500"
                                    value={targetSpeed}
                                    onChange={handleSettingsChange(setTargetSpeed, "tspeed")}
                                />
                            </div>
                            <div className="spinbox-group">
                                <label>Target Pitch:</label>
                                <input
                                    type="number"
                                    min="0" max="100"
                                    value={targetPitch}
                                    onChange={handleSettingsChange(setTargetPitch, "tpitch")}
                                />
                            </div>
                            <div className="spinbox-group">
                                <label>Target %:</label>
                                <input
                                    type="number"
                                    min="0" max="100"
                                    value={targetPercentage}
                                    onChange={handleSettingsChange(setTargetPercentage, "tper")}
                                />
                            </div>
                        </fieldset>
                    </div> {/* End options-container */}
                </div>
            </fieldset>

            {/* Export GroupBox */}
            <fieldset className="group-box">
                <legend>Export</legend>
                <div className="export-controls">
                    <button onClick={handleFunscriptExport} disabled={funscriptResult.length === 0 || isProcessingAny}>Funscript</button>
                    <button onClick={handleHeatmapExport} disabled={Object.keys(audioData).length === 0 || isProcessingAny}>Heatmap</button>
                </div>
            </fieldset>
            {/* Disclaimer for FFMpeg */}
            <p className="disclaimer">
                Note: This web version cannot use FFMpeg for video conversion. Please provide audio files (e.g., MP3, WAV, OGG) directly. Video files may not be supported by the browser's audio API.
            </p>
        </div>
    );
}

export default App;