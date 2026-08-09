export const EXERCISES = Object.freeze({
    box: {
        id: 'box',
        name: 'Box Breathing',
        description: 'Equal phases for steady, balanced breathing.',
        adjustable: { key: 'phaseTime', label: 'Phase time', min: 3, max: 6, step: 1, default: 4 }
    },
    fourSevenEight: {
        id: 'fourSevenEight',
        name: '4-7-8 Breathing',
        description: 'A measured pattern with a longer, unhurried exhale.',
        adjustable: null
    },
    longExhale: {
        id: 'longExhale',
        name: 'Long Exhale',
        description: 'A gentle four-second inhale followed by a longer exhale.',
        adjustable: { key: 'exhaleDuration', label: 'Exhale time', min: 6, max: 8, step: 1, default: 6 }
    },
    coherent: {
        id: 'coherent',
        name: 'Coherent Breathing',
        description: 'Slow, even inhales and exhales at a comfortable pace.',
        adjustable: { key: 'phaseTime', label: 'Breath time', min: 4.5, max: 6, step: 0.5, default: 5 }
    }
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function snapToStep(value, min, step) {
    return Math.round((value - min) / step) * step + min;
}

export function sanitiseRoutine(candidate = {}) {
    const exerciseId = EXERCISES[candidate.exerciseId] ? candidate.exerciseId : 'box';
    const exercise = EXERCISES[exerciseId];
    let phaseTime = Number(candidate.phaseTime);
    let exhaleDuration = Number(candidate.exhaleDuration);

    if (!Number.isFinite(phaseTime)) phaseTime = exerciseId === 'coherent' ? 5 : 4;
    if (!Number.isFinite(exhaleDuration)) exhaleDuration = 6;

    if (exerciseId === 'box') {
        phaseTime = clamp(snapToStep(phaseTime, 3, 1), 3, 6);
    } else if (exerciseId === 'coherent') {
        phaseTime = clamp(snapToStep(phaseTime, 4.5, 0.5), 4.5, 6);
    }
    exhaleDuration = clamp(snapToStep(exhaleDuration, 6, 1), 6, 8);

    const allowedTarget = exerciseId === 'fourSevenEight'
        ? new Set(['open', 'rounds'])
        : new Set(['open', 'minutes']);
    const targetType = allowedTarget.has(candidate.targetType) ? candidate.targetType : 'open';
    let targetValue = Number(candidate.targetValue);
    if (!Number.isFinite(targetValue)) targetValue = 0;
    targetValue = targetType === 'rounds'
        ? clamp(Math.round(targetValue), 1, 99)
        : targetType === 'minutes'
            ? clamp(Math.round(targetValue), 1, 120)
            : 0;

    return { exerciseId, phaseTime, exhaleDuration, targetType, targetValue };
}

export function buildPhases(routine) {
    const clean = sanitiseRoutine(routine);
    switch (clean.exerciseId) {
        case 'fourSevenEight':
            return [
                { name: 'Inhale', duration: 4 },
                { name: 'Hold', duration: 7 },
                { name: 'Exhale', duration: 8 }
            ];
        case 'longExhale':
            return [
                { name: 'Inhale', duration: 4 },
                { name: 'Exhale', duration: clean.exhaleDuration }
            ];
        case 'coherent':
            return [
                { name: 'Inhale', duration: clean.phaseTime },
                { name: 'Exhale', duration: clean.phaseTime }
            ];
        case 'box':
        default:
            return [
                { name: 'Inhale', duration: clean.phaseTime },
                { name: 'Hold', duration: clean.phaseTime },
                { name: 'Exhale', duration: clean.phaseTime },
                { name: 'Wait', duration: clean.phaseTime }
            ];
    }
}

export function getCycleDurationMs(routine) {
    return buildPhases(routine).reduce((total, phase) => total + phase.duration * 1000, 0);
}

export function locatePhase(routine, elapsedMs) {
    const phases = buildPhases(routine);
    const cycleDurationMs = phases.reduce((total, phase) => total + phase.duration * 1000, 0);
    const safeElapsed = Math.max(0, elapsedMs);
    const cycleElapsedMs = safeElapsed % cycleDurationMs;
    let cursor = 0;

    for (let index = 0; index < phases.length; index += 1) {
        const durationMs = phases[index].duration * 1000;
        if (cycleElapsedMs < cursor + durationMs || index === phases.length - 1) {
            const phaseElapsedMs = cycleElapsedMs - cursor;
            return {
                phases,
                phase: phases[index],
                phaseIndex: index,
                phaseElapsedMs,
                phaseRemainingMs: Math.max(0, durationMs - phaseElapsedMs),
                progress: clamp(phaseElapsedMs / durationMs, 0, 1),
                completedRounds: Math.floor(safeElapsed / cycleDurationMs),
                cycleDurationMs
            };
        }
        cursor += durationMs;
    }

    throw new Error('Unable to locate breathing phase.');
}

export function getTargetTiming(routine) {
    const clean = sanitiseRoutine(routine);
    const cycleDurationMs = getCycleDurationMs(clean);
    if (clean.targetType === 'open') {
        return { targetAtMs: null, naturalEndMs: null };
    }
    if (clean.targetType === 'rounds') {
        const end = clean.targetValue * cycleDurationMs;
        return { targetAtMs: end, naturalEndMs: end };
    }

    const targetAtMs = clean.targetValue * 60_000;
    const phases = buildPhases(clean);
    const exhaleIndex = phases.findIndex((phase) => phase.name === 'Exhale');
    const exhaleEndOffsetMs = phases
        .slice(0, exhaleIndex + 1)
        .reduce((total, phase) => total + phase.duration * 1000, 0);
    const positionMs = targetAtMs % cycleDurationMs;

    if (positionMs === 0) {
        return { targetAtMs, naturalEndMs: targetAtMs };
    }

    const cycleStartMs = targetAtMs - positionMs;
    const naturalEndMs = positionMs <= exhaleEndOffsetMs
        ? cycleStartMs + exhaleEndOffsetMs
        : cycleStartMs + cycleDurationMs + exhaleEndOffsetMs;
    return { targetAtMs, naturalEndMs };
}

export class SessionEngine {
    constructor(callbacks = {}, clock = {}) {
        this.callbacks = {
            onTick: callbacks.onTick || (() => {}),
            onPhaseChange: callbacks.onPhaseChange || (() => {}),
            onStatusChange: callbacks.onStatusChange || (() => {}),
            onComplete: callbacks.onComplete || (() => {})
        };
        this.now = clock.now || (() => performance.now());
        this.requestFrame = clock.requestFrame || ((callback) => requestAnimationFrame(callback));
        this.cancelFrame = clock.cancelFrame || ((id) => cancelAnimationFrame(id));
        this.status = 'idle';
        this.routine = sanitiseRoutine();
        this.accumulatedMs = 0;
        this.startedAtMs = 0;
        this.frameId = null;
        this.lastPhaseIndex = -1;
        this.completionReason = null;
        this.returnStatus = 'running';
        this.targetTiming = getTargetTiming(this.routine);
    }

    get elapsedMs() {
        if (this.status === 'running') {
            return this.accumulatedMs + Math.max(0, this.now() - this.startedAtMs);
        }
        return this.accumulatedMs;
    }

    start(routine) {
        this._cancelScheduledFrame();
        this.routine = sanitiseRoutine(routine);
        this.accumulatedMs = 0;
        this.startedAtMs = this.now();
        this.lastPhaseIndex = -1;
        this.completionReason = null;
        this.targetTiming = getTargetTiming(this.routine);
        this._setStatus('running');
        this._tick(this.startedAtMs);
    }

    pause(reason = 'user') {
        if (this.status !== 'running') return false;
        this.accumulatedMs = this.elapsedMs;
        this._cancelScheduledFrame();
        this.pauseReason = reason;
        this._setStatus('paused');
        this._emitFrame(this.accumulatedMs);
        return true;
    }

    resume() {
        if (this.status !== 'paused' && this.status !== 'ending') return false;
        this.startedAtMs = this.now();
        this._setStatus('running');
        this._emitFrame(this.accumulatedMs);
        this.frameId = this.requestFrame((timestamp) => this._tick(timestamp));
        return true;
    }

    beginEnding() {
        if (this.status !== 'running' && this.status !== 'paused') return false;
        this.returnStatus = this.status;
        if (this.status === 'running') {
            this.accumulatedMs = this.elapsedMs;
            this._cancelScheduledFrame();
        }
        this._setStatus('ending');
        this._emitFrame(this.accumulatedMs);
        return true;
    }

    cancelEnding() {
        if (this.status !== 'ending') return false;
        return this.resume();
    }

    completeManually() {
        if (this.status !== 'ending' && this.status !== 'paused' && this.status !== 'running') return false;
        if (this.status === 'running') this.accumulatedMs = this.elapsedMs;
        this._finish('manual', this.accumulatedMs);
        return true;
    }

    reset() {
        this._cancelScheduledFrame();
        this.accumulatedMs = 0;
        this.startedAtMs = 0;
        this.lastPhaseIndex = -1;
        this.completionReason = null;
        this._setStatus('idle');
    }

    _tick(timestamp) {
        if (this.status !== 'running') return;
        const elapsed = this.accumulatedMs + Math.max(0, timestamp - this.startedAtMs);
        const naturalEndMs = this.targetTiming.naturalEndMs;
        if (naturalEndMs !== null && elapsed >= naturalEndMs) {
            this._finish('target', naturalEndMs);
            return;
        }

        this._emitFrame(elapsed);
        this.frameId = this.requestFrame((nextTimestamp) => this._tick(nextTimestamp));
    }

    _emitFrame(elapsedMs) {
        const frame = locatePhase(this.routine, elapsedMs);
        const isFinishing = this.targetTiming.targetAtMs !== null
            && elapsedMs >= this.targetTiming.targetAtMs
            && this.targetTiming.naturalEndMs > elapsedMs;
        const payload = { ...frame, elapsedMs, status: this.status, isFinishing };
        if (frame.phaseIndex !== this.lastPhaseIndex) {
            this.lastPhaseIndex = frame.phaseIndex;
            this.callbacks.onPhaseChange(payload);
        }
        this.callbacks.onTick(payload);
        return payload;
    }

    _finish(reason, elapsedMs) {
        this._cancelScheduledFrame();
        this.accumulatedMs = Math.max(0, elapsedMs);
        const displayElapsed = Math.max(0, this.accumulatedMs - 0.01);
        const payload = this._emitFrame(displayElapsed);
        this.completionReason = reason;
        this._setStatus('complete');
        this.callbacks.onComplete({ ...payload, elapsedMs: this.accumulatedMs, reason });
    }

    _setStatus(status) {
        this.status = status;
        this.callbacks.onStatusChange(status);
    }

    _cancelScheduledFrame() {
        if (this.frameId !== null) {
            this.cancelFrame(this.frameId);
            this.frameId = null;
        }
    }
}
