export function normalize(data) {
    if (!data || data.length === 0) {
        return [];
    }
    const fmin = Math.min(...data);
    const fmax = Math.max(...data);

    if (fmax === fmin) { // Avoid division by zero if all values are the same
        return data.map(() => 0.5); // Or 0, or 1, depending on desired behavior. 0.5 is neutral.
    }

    return data.map(value => (value - fmin) / (fmax - fmin));
}

// From libfun.py
export function default_peak(pos, at) { 
    return [{ at: at, pos: Math.min(Math.max(0, pos), 100) }];
}

export function int_at(pos, at, last_pos, last_at, limit) {
    const before_ratio = Math.abs(last_pos - limit);
    const after_ratio = Math.abs(pos - limit);

    if ((after_ratio + before_ratio) === 0) { // Avoid division by zero
        return at; 
    }
    return (before_ratio * at + after_ratio * last_at) / (after_ratio + before_ratio);
}

export function create_peak_bounce(pos, at, last_pos, last_at) {
    const actions = [];
    const action = (p, a) => actions.push({ at: a, pos: Math.round(p) }); 

    if (last_pos < 0) {
        const tmp_at = int_at(pos, at, last_pos, last_at, 0);
        action(0, tmp_at);
    } else if (last_pos > 100) {
        const tmp_at = int_at(pos, at, last_pos, last_at, 100);
        action(100, tmp_at);
    }

    if (pos > 100) {
        const tmp_at = int_at(pos, at, last_pos, last_at, 100);
        action(100, tmp_at);
        action(200 - pos, at);
    } else if (pos < 0) {
        const tmp_at = int_at(pos, at, last_pos, last_at, 0);
        action(0, tmp_at);
        action(-pos, at);
    } else {
        action(pos, at);
    }

    return actions;
}

export function create_peak_fold(pos, at, last_pos, last_at) {
    const actions = [];
    const action = (p, a) => actions.push({ at: a, pos: Math.round(p) }); 

    const int_att = (last_at + at) / 2;
    const travel = Math.abs(last_pos - pos) / 2;

    if (last_pos < 0) {
        action(last_pos + travel, int_att);
    } else if (last_pos > 100) {
        action(last_pos - travel, int_att);
    }

    if (pos < 0) {
        action(last_pos - travel, int_att);
        action(last_pos, at);
    } else if (pos > 100) {
        action(last_pos + travel, int_att);
        action(last_pos, at);
    } else {
        action(pos, at);
    }

    return actions;
}

const peaks = [default_peak, create_peak_bounce, create_peak_fold];

export function create_actions_barrier(data, start_time = 0, overflow = 0) {
    let last_at = start_time;
    let last_pos = 50; // Initial position

    const actions = [];
    // Ensure data properties exist and are arrays
    if (!data.energy_to_pos || !data.beats || !data.offsets) {
        console.warn("Missing data for create_actions_barrier:", data);
        return actions;
    }

    // Iterate through the minimum length to avoid issues with unequal array sizes
    const num_frames = Math.min(data.energy_to_pos.length, data.beats.length, data.offsets.length);

    for (let i = 0; i < num_frames; i++) {
        const unoffset_pos = data.energy_to_pos[i];
        const at = data.beats[i];
        const offset = data.offsets[i];

        // up
        const intermediate_at = (at + last_at) / 2;
        let pos = unoffset_pos + offset;
        actions.push(...peaks[Math.floor(overflow)](pos, intermediate_at, last_pos, last_at)); // Pass last_pos/last_at to internal peak functions
        last_at = intermediate_at;
        last_pos = pos;

        // down
        pos = (unoffset_pos * -1) + offset;
        actions.push(...peaks[Math.floor(overflow)](pos, at, last_pos, last_at));
        last_at = at;
        last_pos = pos;
    }

    return actions;
}

export function create_actions(
    data,
    energy_multiplier = 1,
    pitch_range = 100,
    overflow = 0,
    amplitude_centering = 0,
    center_offset = 0
) {
    if (!data.pitch || !data.energy) {
        console.warn("Missing 'pitch' or 'energy' in data for create_actions:", data);
        return [];
    }

    // Clone data to avoid modifying original, or ensure it's shallow copy if only adding props
    const processedData = { ...data };

    const normalized_pitch = normalize(data.pitch);
    const normalized_energy = normalize(data.energy);

    const pitch_bias = (100 - pitch_range) / 2;

    processedData.offsets = normalized_pitch
        .slice(0, normalized_energy.length)
        .map((pitch, i) =>
            pitch * pitch_range +
            pitch_bias +
            amplitude_centering * normalized_energy[i] +
            center_offset
        );

    processedData.energy_to_pos = normalized_energy.map(
        e => e * energy_multiplier * 50
    );

    return create_actions_barrier(processedData, overflow);
}

export function _speed(A, B, smax = 400.0) {
    if ((B.at - A.at) === 0) { // Avoid division by zero for time difference
        return 0; // Or a very high number, depending on how you want to handle simultaneous actions
    }
    const v = Math.abs(B.pos - A.pos) / (B.at - A.at);
    return v / smax;
}

export function speed(A, B, smax = 400.0) {
    return Math.max(0.0, Math.min(_speed(A, B, smax), 1.0));
}

export function dumpFunscript(data) {
    if (!data || data.length === 0) {
        return JSON.stringify({
            "actions": [],
            "inverted": false,
            "metadata": {
                "creator": "PythonDancerJS",
                "description": "",
                "duration": 0,
                "license": "None",
                "notes": "",
                "performers": [],
                "script_url": "",
                "tags": [],
                "title": "",
                "type": "basic",
                "video_url": "",
            },
            "range": 100,
            "version": "1.0",
        }, null, 4); // Pretty print
    }

    const actions = data.map(action => ({
        at: Math.round(action.at * 1000), // Convert to milliseconds and round
        pos: Math.round(action.pos)
    }));

    const duration = actions.length > 0 ? actions[actions.length - 1].at : 0; // Duration is in ms

    return JSON.stringify({
        "actions": actions,
        "inverted": false,
        "metadata": {
            "creator": "PythonDancerJS",
            "description": "",
            "duration": duration,
            "license": "None",
            "notes": "",
            "performers": [],
            "script_url": "",
            "tags": [],
            "title": "",
            "type": "basic",
            "video_url": "",
        },
        "range": 100,
        "version": "1.0",
    }, null, 4);
}
