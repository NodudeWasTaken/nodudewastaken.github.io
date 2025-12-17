import { nelderMead } from 'fmin';
import { create_actions, speed, normalize } from './utils';

var i = 0;

export function autoval(data, tpi = 15, target_speed = 300, v2above = 0.6, opt = 1) {
    if (!data || data.length === 0 || !data.pitch || data.pitch.length === 0 || !data.energy || data.energy.length === 0) {
        return [0, 0]; // Return default values if data is empty or invalid
    }

    // Objective function for pitch optimization
    const cmean = (pitch_range_arr) => {
        const pitch_range = pitch_range_arr[0];
        if (pitch_range === 0) return Infinity; // Avoid division by zero or trivial solutions

        const result = create_actions(data, 0, pitch_range); // energy_multiplier=0
        const Y = result.map(a => a.pos);
        if (Y.length === 0) return Infinity; // No actions generated
        const averageY = Y.reduce((sum, val) => sum + val, 0) / Y.length;
        return averageY;
    };

    const pdst = (p_arr) => {
        const p = p_arr[0];
        const a = cmean([p]);
        const b = tpi;
        return Math.abs(a - b);
    };

    // Bounds for pitch_range (similar to SciPy's Nelder-Mead bounds, though custom for this implementation)
    // The original Python code had `bounds=((-200,200),)` for `pres`.
    let pres = 100; // Default if minimization fails
    try {
        const presResult = nelderMead(pdst, [100]);
        // Clamp result within expected range, though Nelder-Mead doesn't strictly adhere to bounds without modifications
        pres = Math.min(200, Math.max(-200, presResult.x[0]));
    } catch (e) {
        console.error("Pitch optimization failed:", e);
    }


    // Objective functions for energy optimization
    const cemean = (energy_multiplier_arr) => {
        const energy_multiplier = energy_multiplier_arr[0];
        if (energy_multiplier < 0) return Infinity; // Energy multiplier must be non-negative

        const result = create_actions(data, energy_multiplier, pres);
        if (result.length < 2) return Infinity; // Need at least two actions to calculate speed
        const speeds = [];
        for (let i = 0; i < result.length - 1; i++) {
            speeds.push(speed(result[i], result[i + 1], 1.0)); // smax=1.0 for normalized speed calculation
        }
        if (speeds.length === 0) return Infinity;
        const averageSpeed = speeds.reduce((sum, val) => sum + val, 0) / speeds.length;
        return Math.abs(averageSpeed - target_speed);
    };

    const cemeanv2 = (energy_multiplier_arr) => {
        const energy_multiplier = energy_multiplier_arr[0];
        if (energy_multiplier < 0) return Infinity;

        const result = create_actions(data, energy_multiplier, pres);
        if (result.length < 2) return Infinity;
        const speeds = [];
        for (let i = 0; i < result.length - 1; i++) {
            speeds.push(speed(result[i], result[i + 1], 400.0)); // Use smax=400.0 for comparison with target_speed
        }
        if (speeds.length === 0) return Infinity;

        const aboveTarget = speeds.filter(s => s > target_speed).length;
        const percentageAboveTarget = aboveTarget / speeds.length;

        return Math.abs(percentageAboveTarget - v2above);
    };

    const celen = (energy_multiplier_arr) => {
        const energy_multiplier = energy_multiplier_arr[0];
        if (energy_multiplier < 0) return Infinity;

        const result = create_actions(data, energy_multiplier, pres);
        if (result.length < 2) return Infinity;
        const distances = [];
        for (let i = 0; i < result.length - 1; i++) {
            distances.push(Math.abs(result[i].pos - result[i + 1].pos));
        }
        if (distances.length === 0) return Infinity;

        const actualPercentage = distances.reduce((sum, val) => sum + val, 0) / (distances.length * 100); // Normalized by 100 range
        return Math.abs(actualPercentage - v2above);
    };

    const optimizers = [cemean, cemeanv2, celen];
    const selectedOptimizer = optimizers[opt];

    let eres = 10; // Default energy multiplier
    try {
        const eresResult = nelderMead(selectedOptimizer, [10]);
        // Clamp result within expected range
        eres = Math.min(100, Math.max(0, eresResult.x[0]));
    } catch (e) {
        console.error("Energy optimization failed:", e);
    }

    return [pres, eres];
}
