import {
    EXERCISES,
    SessionEngine,
    buildPhases,
    getCycleDurationMs,
    sanitiseRoutine
} from './session-engine.js';

const app = document.querySelector('#app');
const settingsLayer = document.querySelector('#settings-layer');
const toast = document.querySelector('#toast');
const phaseAnnouncer = document.querySelector('#phase-announcer');
const hapticProxy = document.querySelector('#ios-haptic-switch');

const SETTINGS_KEY = 'quietBreath.settings.v2';
const LEGACY_KEY = 'breathingExercisesSettings';
const DEFAULT_SETTINGS = Object.freeze({
    soundEnabled: false,
    soundVolume: 30,
    hapticsEnabled: false,
    countdownEnabled: false,
    extraDim: true,
    lastRoutine: null
});

let settings = loadSettings();
let draftRoutine = sanitiseRoutine(settings.lastRoutine || {
    exerciseId: 'box',
    phaseTime: 4,
    exhaleDuration: 6,
    targetType: 'open',
    targetValue: 0
});
let currentView = settings.lastRoutine ? 'home' : 'configure';
let settingsOpen = false;
let lastCompletion = null;
let lastFrame = null;
let hideChromeTimer = null;
let toastTimer = null;
let toastAction = null;
let audioContext = null;
let wakeLockSentinel = null;
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;
let updateReady = false;
let isRefreshingForUpdate = false;
let pausedByInterruption = false;
let lastDisplayedSecond = -1;

const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const engine = new SessionEngine({
    onTick: updateSessionFrame,
    onPhaseChange: handlePhaseChange,
    onStatusChange: handleStatusChange,
    onComplete: handleCompletion
});

function loadSettings() {
    const defaults = { ...DEFAULT_SETTINGS };
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (saved && typeof saved === 'object') {
            return normaliseSettings(saved);
        }

        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
        if (legacy && typeof legacy === 'object') {
            const migrated = normaliseSettings({
                ...defaults,
                soundEnabled: legacy.soundEnabled,
                countdownEnabled: legacy.countdownEnabled,
                lastRoutine: {
                    exerciseId: legacy.exerciseType,
                    phaseTime: legacy.phaseTime,
                    exhaleDuration: legacy.exhaleDuration,
                    targetType: 'open',
                    targetValue: 0
                }
            });
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated));
            return migrated;
        }
    } catch (error) {
        console.warn('Quiet Breath could not read saved preferences.', error);
    }
    return defaults;
}

function normaliseSettings(candidate) {
    const lastRoutine = candidate.lastRoutine ? sanitiseRoutine(candidate.lastRoutine) : null;
    return {
        soundEnabled: typeof candidate.soundEnabled === 'boolean' ? candidate.soundEnabled : false,
        soundVolume: clampNumber(candidate.soundVolume, 0, 100, 30),
        hapticsEnabled: typeof candidate.hapticsEnabled === 'boolean' ? candidate.hapticsEnabled : false,
        countdownEnabled: typeof candidate.countdownEnabled === 'boolean' ? candidate.countdownEnabled : false,
        extraDim: typeof candidate.extraDim === 'boolean' ? candidate.extraDim : true,
        lastRoutine
    };
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.warn('Quiet Breath could not save preferences.', error);
    }
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatElapsed(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatLongDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    if (seconds === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    return `${minutes} min ${seconds} sec`;
}

function formatTarget(routine) {
    if (routine.targetType === 'open') return 'Open-ended';
    if (routine.targetType === 'rounds') {
        return `${routine.targetValue} round${routine.targetValue === 1 ? '' : 's'}`;
    }
    return `${routine.targetValue} minute${routine.targetValue === 1 ? '' : 's'}`;
}

function formatRoutineDetail(routine) {
    const exercise = EXERCISES[routine.exerciseId];
    const pacing = exercise.adjustable
        ? `${routine[exercise.adjustable.key]} second ${exercise.adjustable.label.toLowerCase()}`
        : '4 · 7 · 8 seconds';
    return `${formatTarget(routine)} · ${pacing}`;
}

function topbar({ back = false } = {}) {
    return `
        <header class="topbar">
            ${back ? '<button class="text-button" type="button" data-action="back">Back</button>' : '<p class="wordmark">Quiet Breath</p>'}
            <button class="text-button" type="button" data-action="open-settings" aria-haspopup="dialog">Settings</button>
        </header>
    `;
}

function render() {
    document.body.classList.toggle('extra-dim', settings.extraDim);
    if (currentView === 'configure') renderConfigure();
    else if (currentView === 'session') renderSession();
    else if (currentView === 'complete') renderComplete();
    else renderHome();
    if (settingsOpen) renderSettingsSheet();
}

function renderHome() {
    const routine = sanitiseRoutine(settings.lastRoutine || draftRoutine);
    const exercise = EXERCISES[routine.exerciseId];
    app.innerHTML = `
        <section class="screen home-screen" aria-labelledby="home-title">
            ${topbar()}
            <div class="home-content">
                <p class="eyebrow">Your quiet space</p>
                <h1 id="home-title">Ready when you are.</h1>
                <p class="lead">Settle in and return to your last breathing rhythm.</p>
                <div class="routine-card" aria-label="Last breathing routine">
                    <span class="routine-name">${escapeHtml(exercise.name)}</span>
                    <span class="routine-detail">${escapeHtml(formatRoutineDetail(routine))}</span>
                </div>
                <button class="primary-button" type="button" data-action="begin-last">Begin again</button>
                <button class="secondary-button" type="button" data-action="change-routine">Change routine</button>
                <p class="safety-note">Breathe comfortably. Stop if you feel light-headed or unwell.</p>
            </div>
        </section>
    `;
}

function renderConfigure() {
    const routine = sanitiseRoutine(draftRoutine);
    draftRoutine = routine;
    const exercise = EXERCISES[routine.exerciseId];
    const targetValues = routine.exerciseId === 'fourSevenEight' ? [4, 6, 8] : [2, 5, 10];
    const expectedType = routine.exerciseId === 'fourSevenEight' ? 'rounds' : 'minutes';
    const isPreset = routine.targetType === expectedType && targetValues.includes(routine.targetValue);
    const isCustom = routine.targetType === expectedType && !isPreset;
    const targetUnit = routine.exerciseId === 'fourSevenEight' ? 'rounds' : 'minutes';
    const adjustable = exercise.adjustable;

    app.innerHTML = `
        <section class="screen setup-screen" aria-labelledby="config-title">
            ${topbar({ back: Boolean(settings.lastRoutine) })}
            <div class="config-content">
                <div class="config-intro">
                    <p class="eyebrow">Choose a rhythm</p>
                    <h1 id="config-title" class="config-heading">A breath that fits this moment.</h1>
                    <p class="lead">Keep it simple. You can change the pace whenever you return.</p>
                </div>
                <div class="config-form">
                    <span class="section-label" id="exercise-label">Exercise</span>
                    <div class="exercise-grid" role="radiogroup" aria-labelledby="exercise-label">
                        ${Object.values(EXERCISES).map((item) => `
                            <button class="exercise-card" type="button" role="radio" aria-checked="${item.id === routine.exerciseId}" data-action="select-exercise" data-exercise="${item.id}">
                                <span class="exercise-title">${escapeHtml(item.name)}</span>
                                <span class="exercise-description">${escapeHtml(item.description)}</span>
                            </button>
                        `).join('')}
                    </div>

                    <span class="section-label" id="duration-label">Duration</span>
                    <div class="choice-row" role="radiogroup" aria-labelledby="duration-label">
                        <button class="choice-chip" type="button" role="radio" aria-checked="${routine.targetType === 'open'}" data-action="select-target" data-target-type="open" data-target-value="0">Open</button>
                        ${targetValues.map((value) => `
                            <button class="choice-chip" type="button" role="radio" aria-checked="${routine.targetType === expectedType && routine.targetValue === value}" data-action="select-target" data-target-type="${expectedType}" data-target-value="${value}">${value} ${routine.exerciseId === 'fourSevenEight' ? 'rounds' : 'min'}</button>
                        `).join('')}
                        <button class="choice-chip" type="button" role="radio" aria-checked="${isCustom}" data-action="select-target" data-target-type="${expectedType}" data-target-value="custom">Custom</button>
                    </div>
                    ${isCustom ? `
                        <label class="custom-field" for="custom-target">
                            <input class="number-input" id="custom-target" name="custom-target" type="number" inputmode="numeric" min="1" max="${routine.exerciseId === 'fourSevenEight' ? '99' : '120'}" value="${routine.targetValue}">
                            <span class="field-unit">${targetUnit}</span>
                        </label>
                    ` : ''}

                    ${adjustable ? `
                        <label class="section-label" for="phase-range">${escapeHtml(adjustable.label)}</label>
                        <div class="range-panel">
                            <input id="phase-range" type="range" min="${adjustable.min}" max="${adjustable.max}" step="${adjustable.step}" value="${routine[adjustable.key]}" data-setting-key="${adjustable.key}">
                            <output class="range-value" id="phase-range-output" for="phase-range">${routine[adjustable.key]} sec</output>
                        </div>
                    ` : ''}

                    <div class="config-actions">
                        <button class="primary-button" type="button" data-action="start-session">Begin</button>
                        <p class="safety-note">Breathe comfortably. Stop if you feel light-headed or unwell.</p>
                    </div>
                </div>
            </div>
        </section>
    `;
}

function renderSession() {
    const routine = sanitiseRoutine(settings.lastRoutine || draftRoutine);
    const initialPhase = buildPhases(routine)[0];
    currentView = 'session';
    app.innerHTML = `
        <section class="session-screen" id="session-screen" data-phase="${initialPhase.name}" aria-labelledby="phase-word">
            <header class="session-header session-chrome">
                <p class="wordmark">Quiet Breath</p>
                <span class="session-time" id="session-time">00:00</span>
                <button class="quiet-button" type="button" data-action="open-settings" aria-haspopup="dialog">Settings</button>
            </header>
            <div class="breath-stage">
                <div class="phase-copy">
                    <h1 class="phase-word" id="phase-word">${initialPhase.name}</h1>
                    <p class="phase-countdown" id="phase-countdown">${settings.countdownEnabled ? initialPhase.duration : ''}</p>
                </div>
                <div class="breath-form-wrap" aria-hidden="true">
                    <div class="breath-form" id="breath-form"></div>
                </div>
                <p class="session-state" id="session-state">Settling in</p>
            </div>
            <div class="session-controls session-chrome">
                <button class="primary-button" id="pause-button" type="button" data-action="toggle-pause">Pause</button>
                <button class="secondary-button" type="button" data-action="request-end">End</button>
            </div>
            <div id="confirm-layer"></div>
        </section>
    `;
    lastDisplayedSecond = -1;
    showSessionChrome();
}

function renderEndConfirmation() {
    const layer = document.querySelector('#confirm-layer');
    if (!layer) return;
    layer.innerHTML = `
        <div class="confirm-layer" role="dialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-description">
            <div class="confirm-card">
                <h2 id="end-title">End this session?</h2>
                <p id="end-description">Your breathing time so far will be shown on the completion screen.</p>
                <div class="confirm-actions">
                    <button class="primary-button" type="button" data-action="cancel-end">Continue breathing</button>
                    <button class="danger-button" type="button" data-action="confirm-end">End session</button>
                </div>
            </div>
        </div>
    `;
    layer.querySelector('[data-action="cancel-end"]')?.focus();
}

function clearEndConfirmation() {
    const layer = document.querySelector('#confirm-layer');
    if (layer) layer.innerHTML = '';
}

function renderComplete() {
    const routine = sanitiseRoutine(settings.lastRoutine || draftRoutine);
    const elapsedMs = lastCompletion?.elapsedMs || engine.elapsedMs;
    const completedRounds = Math.floor((elapsedMs + 0.5) / getCycleDurationMs(routine));
    const roundCopy = routine.exerciseId === 'fourSevenEight'
        ? ` · ${completedRounds} complete round${completedRounds === 1 ? '' : 's'}`
        : '';
    app.innerHTML = `
        <section class="screen complete-screen" aria-labelledby="complete-title">
            ${topbar()}
            <div class="complete-content">
                <div class="complete-mark" aria-hidden="true"></div>
                <p class="eyebrow">Session complete</p>
                <h1 id="complete-title">A quieter moment.</h1>
                <p class="completion-stat">${escapeHtml(formatLongDuration(elapsedMs))}${escapeHtml(roundCopy)}</p>
                <button class="primary-button" type="button" data-action="repeat-session">Repeat</button>
                <button class="secondary-button" type="button" data-action="done">Done</button>
            </div>
        </section>
    `;
    if (updateReady) showUpdateToast();
}

function renderSettingsSheet() {
    const installed = isStandalone();
    const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const connectionCopy = navigator.onLine ? 'Ready online and offline' : 'Offline · the app remains ready';
    const installCopy = installed
        ? 'Quiet Breath is installed on this device.'
        : deferredInstallPrompt
            ? 'Install Quiet Breath for a full-screen, offline experience.'
            : isiOS
                ? 'In Safari, tap Share and then Add to Home Screen.'
                : 'Use your browser menu to install Quiet Breath when available.';
    const canInstall = !installed && Boolean(deferredInstallPrompt);

    settingsLayer.innerHTML = `
        <div class="sheet-backdrop" role="presentation" data-backdrop>
            <section class="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-sheet>
                <div class="sheet-header">
                    <div>
                        <p class="eyebrow">Preferences</p>
                        <h2 id="settings-title">Keep it comfortable.</h2>
                    </div>
                    <button class="quiet-button" type="button" data-action="close-settings">Close</button>
                </div>
                <p class="settings-intro">Everything stays on this device.</p>

                ${settingSwitch('soundEnabled', 'Sound cues', 'Soft phase notes and a completion bell.', settings.soundEnabled)}
                <label class="volume-row" for="sound-volume">
                    <span class="setting-copy">
                        <span class="setting-name">Cue volume</span>
                        <span class="setting-note"><span id="volume-output">${settings.soundVolume}</span>% · deliberately limited</span>
                    </span>
                    <input id="sound-volume" name="soundVolume" type="range" min="0" max="100" step="5" value="${settings.soundVolume}" ${settings.soundEnabled ? '' : 'disabled'}>
                </label>
                ${settingSwitch('hapticsEnabled', 'Haptic cues', 'Best-effort taps for inhale, exhale and completion on supported devices.', settings.hapticsEnabled)}
                ${settingSwitch('countdownEnabled', 'Countdown', 'Show the seconds remaining in each phase.', settings.countdownEnabled)}
                ${settingSwitch('extraDim', 'Extra dim', 'Reduce the breathing form glow for bedtime.', settings.extraDim)}

                <div class="status-panel">
                    <div><span class="status-dot"></span>${escapeHtml(connectionCopy)}</div>
                    <p class="install-help">${escapeHtml(installCopy)}</p>
                    ${canInstall ? '<button class="secondary-button" type="button" data-action="install-app">Install Quiet Breath</button>' : ''}
                    ${updateReady ? `<button class="secondary-button" type="button" data-action="apply-update" ${engine.status === 'running' || engine.status === 'paused' || engine.status === 'ending' ? 'disabled' : ''}>${engine.status === 'running' || engine.status === 'paused' || engine.status === 'ending' ? 'Update ready after this session' : 'Update Quiet Breath'}</button>` : ''}
                </div>
            </section>
        </div>
    `;
    settingsLayer.querySelector('[data-action="close-settings"]')?.focus();
}

function settingSwitch(name, label, note, checked) {
    return `
        <label class="setting-row" for="setting-${name}">
            <span class="setting-copy">
                <span class="setting-name">${escapeHtml(label)}</span>
                <span class="setting-note">${escapeHtml(note)}</span>
            </span>
            <input id="setting-${name}" name="${name}" type="checkbox" switch ${checked ? 'checked' : ''}>
        </label>
    `;
}

function openSettings() {
    settingsOpen = true;
    clearHideChromeTimer();
    renderSettingsSheet();
    document.body.style.overflow = 'hidden';
}

function closeSettings() {
    settingsOpen = false;
    settingsLayer.innerHTML = '';
    document.body.style.overflow = '';
    if (currentView === 'session' && engine.status === 'running') scheduleChromeHide();
    app.focus({ preventScroll: true });
}

function startRoutine(routine) {
    draftRoutine = sanitiseRoutine(routine);
    settings.lastRoutine = draftRoutine;
    saveSettings();
    currentView = 'session';
    lastCompletion = null;
    prepareAudio();
    renderSession();
    engine.start(draftRoutine);
}

function handleAppClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const action = control.dataset.action;

    if (action === 'open-settings') openSettings();
    else if (action === 'begin-last') startRoutine(settings.lastRoutine);
    else if (action === 'change-routine') {
        draftRoutine = sanitiseRoutine(settings.lastRoutine);
        currentView = 'configure';
        render();
    } else if (action === 'select-exercise') {
        const exerciseId = control.dataset.exercise;
        const exercise = EXERCISES[exerciseId];
        draftRoutine = sanitiseRoutine({
            exerciseId,
            phaseTime: exerciseId === 'coherent' ? 5 : 4,
            exhaleDuration: 6,
            targetType: 'open',
            targetValue: 0
        });
        renderConfigure();
    } else if (action === 'select-target') {
        const targetType = control.dataset.targetType;
        const rawValue = control.dataset.targetValue;
        const defaultCustom = draftRoutine.exerciseId === 'fourSevenEight' ? 5 : 7;
        draftRoutine = sanitiseRoutine({
            ...draftRoutine,
            targetType,
            targetValue: rawValue === 'custom' ? defaultCustom : Number(rawValue)
        });
        renderConfigure();
        if (rawValue === 'custom') document.querySelector('#custom-target')?.focus();
    } else if (action === 'start-session') startRoutine(draftRoutine);
    else if (action === 'back') {
        currentView = 'home';
        renderHome();
    } else if (action === 'toggle-pause') {
        if (engine.status === 'running') engine.pause('user');
        else if (engine.status === 'paused') engine.resume();
    } else if (action === 'request-end') {
        if (engine.beginEnding()) renderEndConfirmation();
    } else if (action === 'cancel-end') {
        clearEndConfirmation();
        engine.cancelEnding();
    } else if (action === 'confirm-end') {
        clearEndConfirmation();
        engine.completeManually();
    } else if (action === 'repeat-session') startRoutine(settings.lastRoutine);
    else if (action === 'done') {
        engine.reset();
        currentView = 'home';
        renderHome();
    }
}

function handleInput(event) {
    const target = event.target;
    if (target.id === 'phase-range') {
        const key = target.dataset.settingKey;
        draftRoutine = sanitiseRoutine({ ...draftRoutine, [key]: Number(target.value) });
        const output = document.querySelector('#phase-range-output');
        if (output) output.textContent = `${draftRoutine[key]} sec`;
    } else if (target.id === 'custom-target') {
        draftRoutine = sanitiseRoutine({ ...draftRoutine, targetValue: Number(target.value) });
    } else if (target.name === 'soundVolume') {
        settings.soundVolume = clampNumber(target.value, 0, 100, 30);
        const output = document.querySelector('#volume-output');
        if (output) output.textContent = settings.soundVolume;
        saveSettings();
    }
}

function handleChange(event) {
    const target = event.target;
    if (!['soundEnabled', 'hapticsEnabled', 'countdownEnabled', 'extraDim'].includes(target.name)) return;
    settings[target.name] = target.checked;
    if (target.name === 'soundEnabled' && target.checked) prepareAudio();
    if (target.name === 'extraDim') document.body.classList.toggle('extra-dim', settings.extraDim);
    saveSettings();
    renderSettingsSheet();
    if (currentView === 'session' && lastFrame) updateSessionFrame(lastFrame);
}

function handleSettingsClick(event) {
    if (event.target.matches('[data-backdrop]')) {
        closeSettings();
        return;
    }
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const action = control.dataset.action;
    if (action === 'close-settings') closeSettings();
    else if (action === 'install-app') installApp();
    else if (action === 'apply-update') applyUpdate();
}

function updateSessionFrame(frame) {
    lastFrame = frame;
    if (currentView !== 'session') return;
    const screen = document.querySelector('#session-screen');
    const breathForm = document.querySelector('#breath-form');
    const phaseWord = document.querySelector('#phase-word');
    const countdown = document.querySelector('#phase-countdown');
    const timer = document.querySelector('#session-time');
    const stateLabel = document.querySelector('#session-state');
    if (!screen || !breathForm || !phaseWord || !countdown || !timer || !stateLabel) return;

    const eased = 0.5 - Math.cos(Math.PI * frame.progress) / 2;
    let scale = 0.72;
    if (frame.phase.name === 'Inhale') scale = 0.72 + 0.28 * eased;
    else if (frame.phase.name === 'Exhale') scale = 1 - 0.28 * eased;
    else if (frame.phase.name === 'Hold') scale = 1;
    if (reducedMotionQuery?.matches) scale = 0.86;

    breathForm.style.setProperty('--breath-scale', scale.toFixed(4));
    screen.dataset.phase = frame.phase.name;
    phaseWord.textContent = frame.phase.name;
    countdown.textContent = settings.countdownEnabled ? formatCountdown(frame) : '';

    const currentSecond = Math.floor(frame.elapsedMs / 1000);
    if (currentSecond !== lastDisplayedSecond) {
        lastDisplayedSecond = currentSecond;
        if (settings.lastRoutine?.targetType === 'rounds') {
            const currentRound = Math.min(frame.completedRounds + 1, settings.lastRoutine.targetValue);
            timer.textContent = `Round ${currentRound} of ${settings.lastRoutine.targetValue}`;
        } else {
            timer.textContent = formatElapsed(frame.elapsedMs);
        }
    }

    if (engine.status === 'paused') stateLabel.textContent = 'Paused';
    else if (engine.status === 'ending') stateLabel.textContent = 'Waiting for you';
    else if (frame.isFinishing) stateLabel.textContent = 'Finishing this breath';
    else stateLabel.textContent = EXERCISES[settings.lastRoutine.exerciseId].name;
}

function formatCountdown(frame) {
    const seconds = frame.phaseRemainingMs / 1000;
    const durationHasHalf = frame.phase.duration % 1 !== 0;
    if (durationHasHalf && seconds > Math.floor(frame.phase.duration)) {
        return frame.phase.duration.toFixed(1);
    }
    return String(Math.max(1, Math.ceil(seconds)));
}

function handlePhaseChange(frame) {
    if (currentView !== 'session') return;
    phaseAnnouncer.textContent = frame.phase.name;
    if (engine.status === 'running') {
        playPhaseCue(frame.phase.name);
        if (frame.phase.name === 'Inhale' || frame.phase.name === 'Exhale') {
            triggerHaptic('phase');
        }
    }
}

function handleStatusChange(status) {
    if (status === 'running') {
        requestWakeLock();
        scheduleChromeHide();
    } else {
        releaseWakeLock();
        showSessionChrome(false);
    }
    if (currentView === 'session') {
        const pauseButton = document.querySelector('#pause-button');
        if (pauseButton) pauseButton.textContent = status === 'paused' ? 'Resume' : 'Pause';
        if (lastFrame) updateSessionFrame({ ...lastFrame, status });
    }
}

function handleCompletion(payload) {
    lastCompletion = payload;
    playCompletionCue();
    triggerHaptic('completion');
    currentView = 'complete';
    clearHideChromeTimer();
    renderComplete();
}

function prepareAudio() {
    if (!settings.soundEnabled) return;
    try {
        audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
    } catch (error) {
        console.warn('Audio cues are not available on this device.', error);
    }
}

function playTone(frequency, duration, startOffset = 0, peak = 0.055) {
    if (!settings.soundEnabled) return;
    prepareAudio();
    if (!audioContext) return;
    const start = audioContext.currentTime + startOffset;
    const end = start + duration;
    const gain = audioContext.createGain();
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    const scaledPeak = peak * (settings.soundVolume / 100);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, scaledPeak), start + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
}

function playPhaseCue(phaseName) {
    const cues = {
        Inhale: [392, 0.24],
        Hold: [330, 0.18],
        Exhale: [293.66, 0.28],
        Wait: [261.63, 0.16]
    };
    const cue = cues[phaseName];
    if (cue) playTone(cue[0], cue[1]);
}

function playCompletionCue() {
    playTone(392, 0.38, 0, 0.065);
    playTone(523.25, 0.48, 0.3, 0.055);
}

function triggerHaptic(kind) {
    if (!settings.hapticsEnabled) return;
    try {
        if (typeof navigator.vibrate === 'function') {
            navigator.vibrate(kind === 'completion' ? [18, 70, 18] : 12);
            return;
        }
        // iOS 18 provides a system haptic for native switch controls. A synthetic
        // click is intentionally only a best-effort fallback and may be declined.
        hapticProxy?.click();
        if (kind === 'completion') window.setTimeout(() => hapticProxy?.click(), 140);
    } catch (error) {
        // Haptics are supplementary; visual guidance remains authoritative.
    }
}

async function requestWakeLock() {
    if (document.visibilityState !== 'visible' || engine.status !== 'running' || !('wakeLock' in navigator)) return;
    try {
        if (!wakeLockSentinel) {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            wakeLockSentinel.addEventListener('release', () => {
                wakeLockSentinel = null;
            }, { once: true });
        }
    } catch (error) {
        wakeLockSentinel = null;
    }
}

async function releaseWakeLock() {
    if (!wakeLockSentinel) return;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    try {
        await sentinel.release();
    } catch (error) {
        // The browser may already have released it during an interruption.
    }
}

function showSessionChrome(schedule = true) {
    document.querySelector('#session-screen')?.classList.remove('chrome-hidden');
    if (schedule && engine.status === 'running' && !settingsOpen) scheduleChromeHide();
}

function scheduleChromeHide() {
    clearHideChromeTimer();
    if (currentView !== 'session' || engine.status !== 'running' || settingsOpen) return;
    hideChromeTimer = window.setTimeout(() => {
        document.querySelector('#session-screen')?.classList.add('chrome-hidden');
    }, 5000);
}

function clearHideChromeTimer() {
    if (hideChromeTimer) window.clearTimeout(hideChromeTimer);
    hideChromeTimer = null;
}

function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function installApp() {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (settingsOpen) renderSettingsSheet();
}

function showToast(message, actionLabel = '', action = null, timeout = 5000) {
    if (toastTimer) window.clearTimeout(toastTimer);
    toastAction = action;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>${actionLabel ? `<button type="button" data-toast-action>${escapeHtml(actionLabel)}</button>` : ''}`;
    toast.setAttribute('aria-hidden', 'false');
    if (timeout > 0) {
        toastTimer = window.setTimeout(hideToast, timeout);
    }
}

function hideToast() {
    toast.setAttribute('aria-hidden', 'true');
    toastAction = null;
    toastTimer = null;
}

function showUpdateToast() {
    const sessionActive = ['running', 'paused', 'ending'].includes(engine.status);
    if (sessionActive) showToast('An update is ready after this session.', '', null, 5000);
    else showToast('A quieter update is ready.', 'Update', applyUpdate, 0);
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        serviceWorkerRegistration = await navigator.serviceWorker.register('./service-worker.js');
        if (serviceWorkerRegistration.waiting) {
            updateReady = true;
            showUpdateToast();
        }
        serviceWorkerRegistration.addEventListener('updatefound', () => {
            const worker = serviceWorkerRegistration.installing;
            worker?.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                    updateReady = true;
                    showUpdateToast();
                    if (settingsOpen) renderSettingsSheet();
                }
            });
        });
    } catch (error) {
        console.warn('Offline installation is not available in this context.', error);
    }
}

function applyUpdate() {
    if (!serviceWorkerRegistration?.waiting || ['running', 'paused', 'ending'].includes(engine.status)) return;
    isRefreshingForUpdate = true;
    serviceWorkerRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

app.addEventListener('click', handleAppClick);
app.addEventListener('input', handleInput);
settingsLayer.addEventListener('input', handleInput);
settingsLayer.addEventListener('change', handleChange);
settingsLayer.addEventListener('click', handleSettingsClick);

toast.addEventListener('click', (event) => {
    if (event.target.closest('[data-toast-action]') && toastAction) toastAction();
});

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (settingsOpen) renderSettingsSheet();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showToast('Quiet Breath is installed.', '', null, 3500);
    if (settingsOpen) renderSettingsSheet();
});

window.addEventListener('online', () => {
    showToast('Back online. Quiet Breath remains ready offline.', '', null, 3500);
    if (settingsOpen) renderSettingsSheet();
});

window.addEventListener('offline', () => {
    showToast('You are offline. Quiet Breath will work normally.', '', null, 4500);
    if (settingsOpen) renderSettingsSheet();
});

navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (isRefreshingForUpdate) window.location.reload();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && engine.status === 'running') {
        pausedByInterruption = engine.pause('interruption');
    } else if (document.visibilityState === 'visible' && pausedByInterruption) {
        pausedByInterruption = false;
        showSessionChrome(false);
        showToast('Paused while you were away.', '', null, 3500);
    }
});

document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isFormControl = target instanceof HTMLInputElement || target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === 'Escape') {
        if (settingsOpen) closeSettings();
        else if (engine.status === 'ending') {
            clearEndConfirmation();
            engine.cancelEnding();
        } else if (currentView === 'session') showSessionChrome();
    } else if (event.code === 'Space' && currentView === 'session' && !isFormControl && !settingsOpen) {
        event.preventDefault();
        if (engine.status === 'running') engine.pause('user');
        else if (engine.status === 'paused') engine.resume();
    }
});

document.addEventListener('pointerdown', () => {
    if (currentView === 'session') showSessionChrome();
}, { passive: true });

document.addEventListener('mousemove', () => {
    if (currentView === 'session' && engine.status === 'running') showSessionChrome();
}, { passive: true });

document.addEventListener('focusin', () => {
    if (currentView === 'session') showSessionChrome();
});

reducedMotionQuery?.addEventListener?.('change', () => {
    if (lastFrame) updateSessionFrame(lastFrame);
});

document.body.classList.toggle('extra-dim', settings.extraDim);
render();
registerServiceWorker();
