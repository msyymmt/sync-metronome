// Socket.io クライアント
let socket;
let audioContext;
let clickBuffer;
let accentBuffer;
let nextNoteTime = 0.0;
let timerID;
let isPlaying = false;
let currentBeat = 0;
let role = ''; // 'host' or 'client'
let roomId = null;
let settings = {
    bpm: 120,
    beatsPerBar: 4,
    beatUnit: 4
};
let timeOffset = 0; // サーバー時刻 - クライアント時刻
let wakeLock = null; // 画面スリープ防止

// デバッグ情報を画面に表示
function showDebug(msg) {
    console.log(msg);
    let debugEl = document.getElementById('debugInfo');
    if (!debugEl) {
        debugEl = document.createElement('div');
        debugEl.id = 'debugInfo';
        // デフォルト非表示 (display: none)
        // タッチ操作の邪魔にならないよう pointer-events は auto (スクロール用) だが、
        // 表示領域は最小限にする
        debugEl.style.cssText = 'display:none; position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.8);color:#0f0;padding:10px;font-size:10px;font-family:monospace;max-height:120px;overflow-y:auto;z-index:9999;';
        document.body.appendChild(debugEl);
    }
    const time = new Date().toLocaleTimeString();
    debugEl.innerHTML = `[${time}] ${msg}<br>` + debugEl.innerHTML;
}

// デバッグログの表示切り替え（画面タイトルなどをタップで呼び出し）
function toggleDebugLog() {
    const debugEl = document.getElementById('debugInfo');
    if (debugEl) {
        if (debugEl.style.display === 'none') {
            debugEl.style.display = 'block';
            showDebug('デバッグログを表示しました');
        } else {
            debugEl.style.display = 'none';
        }
    }
}
window.toggleDebugLog = toggleDebugLog;

// オフライン検出
let isOffline = !navigator.onLine;

function updateOnlineStatus() {
    isOffline = !navigator.onLine;
    const banner = document.getElementById('offlineBanner');
    if (banner) {
        banner.style.display = isOffline ? 'flex' : 'none';
    }
    // オフライン時、役割選択画面にいる場合は同期ボタンを無効化
    const clientBtn = document.querySelector('.client-btn');
    if (clientBtn) {
        clientBtn.disabled = isOffline;
        clientBtn.style.opacity = isOffline ? '0.4' : '1';
        clientBtn.style.pointerEvents = isOffline ? 'none' : 'auto';
    }
    // ホスト画面で接続中に切れた場合の表示
    if (isOffline && role === 'host' && document.getElementById('hostScreen').classList.contains('active')) {
        showDebug('オフラインになりました。ソロモードで動作します。');
    }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// 役割選択
function selectRole(selectedRole) {
    role = selectedRole;
    initAudio();

    document.getElementById('roleSelection').classList.remove('active');

    if (role === 'host') {
        document.getElementById('hostScreen').classList.add('active');
        if (isOffline) {
            // オフライン: ソロモードとして動作（サーバー接続なし）
            showDebug('オフラインモード: ソロメトロノームとして動作');
            document.querySelector('.connection-card').style.display = 'none';
        } else {
            connectSocket(() => {
                showDebug('ホストとしてルーム作成中...');
                socket.emit('createRoom', { hostName: 'ホスト' });
            });
        }
    } else {
        document.getElementById('clientScreen').classList.add('active');
        connectSocket(() => {
            showDebug('ルーム検索中...');
            socket.emit('getAvailableRooms');
            showDebug('要求送信完了');
        });
    }
}

// Socket.io 接続
function connectSocket(onConnected) {
    showDebug('Socket.io 接続開始...');

    // Socket.io のインスタンス作成（自動的に接続）
    socket = io({
        reconnection: true,             // 自動再接続
        reconnectionAttempts: Infinity, // 無限に再試行
        reconnectionDelay: 1000,        // 1秒ごとに再試行
        timeout: 20000                  // 20秒でタイムアウト
    });

    socket.on('connect', () => {
        showDebug(`✅ サーバー接続成功 (ID: ${socket.id})`);
        if (onConnected) onConnected();
    });

    socket.on('connect_error', (error) => {
        showDebug(`❌ 接続エラー: ${error.message}`);
    });

    socket.on('disconnect', (reason) => {
        showDebug(`⚠️ 切断されました: ${reason}`);
        stopPeriodicSync();
    });

    // 時刻同期開始 + 定期再同期
    calculateOffset();
    startPeriodicSync();

    // --- イベントハンドラ ---

    socket.on('roomCreated', (data) => {
        roomId = data.roomId;
        document.getElementById('roomIdDisplay').textContent = roomId;
        showDebug(`ルーム作成完了: ${roomId}`);
    });

    socket.on('availableRooms', (data) => {
        showDebug(`ルームリスト受信: ${data.rooms.length}件`);
        updateRoomList(data.rooms);
    });

    socket.on('clientJoined', (data) => {
        showDebug(`${data.clientName} が参加 (計${data.clientCount}人)`);
        updateClientCount(data.clientCount);
    });

    socket.on('clientLeft', (data) => {
        showDebug(`${data.clientName} が退出 (残${data.clientCount}人)`);
        updateClientCount(data.clientCount);
    });

    socket.on('joinedRoom', (data) => {
        roomId = data.roomId;
        settings = data.settings;
        showDebug(`ルーム ${roomId} に参加しました`);
        updateUI();

        // document.getElementById('clientStatus').textContent = `ホスト: ${data.hostName} に接続中`;
        // document.querySelector('.metronome-container').classList.add('active'); // 削除：クラスが存在しない

        // UI更新で表示切り替え
        const controls = document.getElementById('clientControls');
        if (controls) controls.classList.remove('hidden');

        // 参加後にAudioContext再開を促す
        if (audioContext && audioContext.state === 'suspended') {
            showDebug('画面をタップして音声同期を有効にしてください');
        }
    });

    socket.on('settingsUpdated', (data) => {
        settings = data.settings;
        showDebug(`設定更新: BPM ${settings.bpm}`);
        updateUI();
        resyncScheduler();
    });

    socket.on('start', (data) => {
        showDebug('Startメッセージ受信');
        try {
            settings = data.settings;
            updateUI();
            showDebug('startMetronome呼び出し...');
            startMetronome(data.startTime, data.includeCountIn);
        } catch (e) {
            showDebug(`処理エラー: ${e.message}`);
            console.error(e);
        }
    });

    socket.on('stop', () => {
        showDebug('Stopメッセージ受信');
        stopMetronome();
    });

    socket.on('roomClosed', (data) => {
        alert(data.message);
        location.reload();
    });

    // 時刻同期レスポンスは calculateOffset 内で処理するため、
    // ここではグローバルなイベントハンドラとしては定義せず、
    // calculateOffset 関数内の socket.once で受け取る形にします。
    // (以前の syncPong ハンドラは削除)
}

// 時刻同期処理 (NTPライク、改良版)
// - 10サンプル計測、IQR外れ値除外
// - performance.now()で高精度タイムスタンプ
// - 30秒ごとに定期再同期
let syncIntervalId = null;
const SYNC_INTERVAL_MS = 30000; // 30秒
const SYNC_SAMPLE_COUNT = 10;

async function calculateOffset() {
    if (!socket || !socket.connected) return;
    showDebug('時刻同期を開始...');
    const samples = [];

    for (let i = 0; i < SYNC_SAMPLE_COUNT; i++) {
        const result = await new Promise(resolve => {
            const t0 = performance.now();
            const wallT0 = Date.now();
            socket.emit('syncPing', { clientTime: wallT0 });

            socket.once('syncPong', (data) => {
                const t1 = performance.now();
                const wallT1 = Date.now();
                const rtt = t1 - t0; // performance.now()で高精度RTT計測
                const estimatedServerTime = data.serverTime + (rtt / 2);
                const offset = estimatedServerTime - wallT1;
                resolve({ rtt, offset });
            });

            setTimeout(() => resolve(null), 1000);
        });

        if (result) {
            samples.push(result);
            await new Promise(r => setTimeout(r, 80));
        }
    }

    if (samples.length < 3) {
        showDebug('⚠️ 時刻同期: サンプル不足');
        return;
    }

    // IQR（四分位範囲）で外れ値を除外
    samples.sort((a, b) => a.rtt - b.rtt);
    const q1Index = Math.floor(samples.length * 0.25);
    const q3Index = Math.floor(samples.length * 0.75);
    const q1Rtt = samples[q1Index].rtt;
    const q3Rtt = samples[q3Index].rtt;
    const iqr = q3Rtt - q1Rtt;
    const upperBound = q3Rtt + 1.5 * iqr;

    const filtered = samples.filter(s => s.rtt <= upperBound);

    if (filtered.length === 0) {
        showDebug('⚠️ 時刻同期: 有効サンプルなし');
        return;
    }

    // フィルタ後のRTT最小サンプルを採用（最も信頼性が高い）
    const best = filtered[0];
    timeOffset = best.offset;
    showDebug(`✅ 同期完了: offset=${timeOffset.toFixed(0)}ms RTT=${best.rtt.toFixed(0)}ms (${filtered.length}/${samples.length}サンプル有効)`);

    const syncInfo = document.getElementById('syncOffset');
    if (syncInfo) syncInfo.textContent = `Sync: ${timeOffset.toFixed(0)}ms (RTT ${best.rtt.toFixed(0)}ms)`;
}

// 定期再同期の開始・停止
function startPeriodicSync() {
    stopPeriodicSync();
    syncIntervalId = setInterval(() => {
        if (socket && socket.connected) {
            calculateOffset();
        }
    }, SYNC_INTERVAL_MS);
}

function stopPeriodicSync() {
    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
    }
}

// ルームリスト更新
function updateRoomList(rooms) {
    showDebug(`UI更新開始: ${rooms.length}件のデータ`);
    showDebug(`データ詳細: ${JSON.stringify(rooms)}`);

    const listElement = document.getElementById('roomList');
    listElement.innerHTML = '';

    if (rooms.length === 0) {
        listElement.innerHTML = '<div class="room-item">No rooms found</div>';
        return;
    }

    rooms.forEach(room => {
        const div = document.createElement('div');
        div.className = 'room-item';
        div.innerHTML = `
            <div style="font-size:18px; font-weight:bold; color:var(--accent-blue); margin-bottom:4px;">ID: ${room.id}</div>
            <div style="color:var(--text-secondary); font-size:12px;">参加者: ${room.clientCount}人</div>
        `;
        div.onclick = () => {
            showDebug(`ルーム ${room.id} に参加要求...`);
            socket.emit('joinRoom', { roomId: room.id, clientName: 'メンバー' });
        };
        listElement.appendChild(div);
    });
}

function updateClientCount(count) {
    const container = document.getElementById('connectedClients');
    if (!container) return;

    if (count > 0) {
        container.innerHTML = `
            <div class="client-item" style="justify-content:center;">
                ${count} member${count > 1 ? 's' : ''} connected
            </div>
        `;
    } else {
        container.innerHTML = '<p class="waiting-text">No members yet</p>';
    }
}

// 設定変更（ホストのみ）
function updateSettings(key, value) {
    if (role !== 'host') return;

    if (key === 'bpm') settings.bpm = parseInt(value);
    if (key === 'beatsPerBar') settings.beatsPerBar = parseInt(value);

    updateUI();
    resyncScheduler();

    // サーバーに通知
    if (socket && roomId) {
        socket.emit('updateSettings', { settings: settings });
    }
}

// 再生中にBPM/拍子が変わった時、スケジューラーのタイミングを現在時刻から再計算
function resyncScheduler() {
    if (!isPlaying || !audioContext) return;
    // 次のビートを現在時刻の直後に再スケジュール
    nextNoteTime = audioContext.currentTime + 0.02;
    showDebug(`Scheduler resync: BPM=${settings.bpm}`);
}

function updateUI() {
    // BPM表示の更新
    const bpmId = role === 'host' ? 'bpmValue' : 'clientBpmValue';
    const bpmEl = document.getElementById(bpmId);
    if (bpmEl) bpmEl.textContent = settings.bpm;

    // スライダー更新（ホストのみ）
    if (role === 'host') {
        const slider = document.getElementById('bpmSlider');
        if (slider) slider.value = settings.bpm;
    }

    // 拍子表示の更新 (削除)
    /*
    const beatId = role === 'host' ? 'hostBeatDisplay' : 'clientBeatDisplay';
    const beatContainer = document.getElementById(beatId);
    
    if (beatContainer) {
        beatContainer.innerHTML = '';
        for (let i = 0; i < settings.beatsPerBar; i++) {
            const dot = document.createElement('div');
            dot.className = 'beat-dot';
            // 数字は表示せず、ドットのみにする
            if (i === 0) dot.classList.add('accent');
            beatContainer.appendChild(dot);
        }
    }
    */

    // クライアントの拍子表示テキスト更新
    if (role !== 'host') {
        const sigEl = document.getElementById('clientSignature');
        // HTML側で settings.beatUnit がまだ反映されていないため、一旦デフォルト値対応
        const unit = settings.beatUnit || 4;
        if (sigEl) sigEl.textContent = `${settings.beatsPerBar}/${unit}`;

        // クライアントUIを表示
        const controls = document.getElementById('clientControls');
        if (controls) controls.classList.remove('hidden');

        // ルームリストは隠す
        const roomList = document.getElementById('roomList');
        if (roomList) roomList.innerHTML = '';

        const statusHeader = document.getElementById('clientConnectionStatus');
        if (statusHeader) {
            statusHeader.innerHTML = '<span>Connected to host</span>';
        }
    }
}

// 画面遷移用
function goBack() {
    location.reload();
}
window.goBack = goBack;

// BPM調整（+ - ボタン）
function adjustBpm(delta) {
    if (role !== 'host') return;
    const newBpm = settings.bpm + delta;
    if (newBpm >= 40 && newBpm <= 240) {
        updateSettings('bpm', newBpm);
    }
}
window.adjustBpm = adjustBpm;

// BPMスライダー
function updateBpm(value) {
    updateSettings('bpm', value);
}
window.updateBpm = updateBpm;

// 拍子選択
function selectSignature(btn) {
    if (role !== 'host') return;

    // UI更新
    document.querySelectorAll('.sig-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const beats = parseInt(btn.dataset.beats);
    const unit = parseInt(btn.dataset.unit);

    settings.beatsPerBar = beats;
    settings.beatUnit = unit;

    updateSettings('beatsPerBar', beats);
    // beatUnitも送る必要あり（updateSettings関数を修正するか、まとめて送る）
    if (socket && roomId) {
        socket.emit('updateSettings', { settings: settings });
    }
    updateUI();
}
window.selectSignature = selectSignature;

// ===================================
// Web Audio API メトロノームエンジン
// ===================================

async function initAudio() {
    if (audioContext) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        showDebug(`AudioContext初期化: ${audioContext.state}`);

        // iOS対応: 無音バッファ再生
        const buffer = audioContext.createBuffer(1, 1, 22050);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start(0);

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
            showDebug(`AudioContext再開: ${audioContext.state}`);
        }
    } catch (e) {
        showDebug(`AudioContextエラー: ${e.message}`);
    }

    clickBuffer = createClickSound(800, 0.05);
    accentBuffer = createClickSound(1000, 0.08);
}

function createClickSound(freq, duration) {
    if (!audioContext) return null;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'square';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.5, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    // バッファにレンダリングする代わりに、Oscillatorを都度生成する方式に変更（シンプル化）
    // バッファ化したい場合は OfflineAudioContext を使うが、今回はリアルタイム生成で十分
    return { freq, duration };
}

function playClick(time, isAccent) {
    if (!audioContext) return;

    // デバッグ: 最初の1回だけログを出す
    if (Math.random() < 0.05) showDebug(`音再生: ${time.toFixed(3)} (現在: ${audioContext.currentTime.toFixed(3)})`);

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.frequency.value = isAccent ? 1000 : 800; // アクセントなら高音

    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start(time);
    osc.stop(time + 0.1);
}

function startMetronome(startTime, includeCountIn) {
    showDebug('startMetronome関数開始');
    if (isPlaying) {
        stopMetronome();
    }

    isPlaying = true;
    currentBeat = 0;

    // サーバー時刻ベースの開始時刻をAudioContext時刻に変換
    // Date.now() + timeOffset ≈ サーバー時刻（現在）
    // startTime はサーバー時刻での開始予定時刻
    // delay = 開始予定までの秒数
    const serverNow = Date.now() + timeOffset;
    const delaySec = (startTime - serverNow) / 1000;

    // AudioContext.currentTime に delay を足して、AudioContextの時間軸で開始時刻を決定
    // これにより Date.now() → AudioContext.currentTime の変換は1回だけ行い、
    // 以降は全て AudioContext の高精度タイムベースで動作する
    nextNoteTime = audioContext.currentTime + Math.max(0.02, delaySec);

    showDebug(`開始まで: ${delaySec.toFixed(3)}秒 → audioTime: ${nextNoteTime.toFixed(3)} (now: ${audioContext.currentTime.toFixed(3)})`);

    scheduler();
    updatePlayButton(true);
    acquireWakeLock();
}

function stopMetronome() {
    isPlaying = false;
    clearTimeout(timerID);
    updatePlayButton(false);
    releaseWakeLock();
}

// Wake Lock: 再生中に画面スリープを防止
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        showDebug('Wake Lock acquired');
        wakeLock.addEventListener('release', () => {
            showDebug('Wake Lock released');
            wakeLock = null;
        });
    } catch (e) {
        showDebug(`Wake Lock failed: ${e.message}`);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// タブ復帰時にWake Lockを再取得（ブラウザがバックグラウンドから戻った時に失われるため）
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPlaying && !wakeLock) {
        acquireWakeLock();
    }
});

function scheduler() {
    // 0.1秒先までスケジュール
    while (nextNoteTime < audioContext.currentTime + 0.1) {
        scheduleNote(currentBeat, nextNoteTime);
        nextNote();
    }
    if (isPlaying) {
        timerID = setTimeout(scheduler, 25);
    }
}

function nextNote() {
    const secondsPerBeat = 60.0 / settings.bpm;
    nextNoteTime += secondsPerBeat;
    currentBeat++;
    if (currentBeat >= settings.beatsPerBar) {
        currentBeat = 0;
    }
}

function scheduleNote(beatNumber, time) {
    // 音を鳴らす
    playClick(time, beatNumber === 0);

    // ビジュアル更新 (削除)
    /*
    const drawTime = (time - audioContext.currentTime) * 1000;
    setTimeout(() => {
        updateBeatVisual(beatNumber);
    }, Math.max(0, drawTime));
    */
}

function updateBeatVisual(beatNumber) {
    // 削除
}

function togglePlay() {
    // オフライン or ソケット未接続時はソロモード
    if (!socket || isOffline) {
        if (isPlaying) {
            stopMetronome();
        } else {
            const startTime = Date.now() + 200;
            startMetronome(startTime, false);
        }
        return;
    }

    if (isPlaying) {
        socket.emit('stop');
    } else {
        if (role === 'host') {
            socket.emit('start', {
                settings: settings,
                includeCountIn: false
            });
        }
    }
}

// HTMLから呼び出せるようにグローバルスコープに割り当て
window.togglePlayHost = togglePlay;

function updatePlayButton(playing) {
    if (role === 'host') {
        const btn = document.getElementById('hostPlayBtn');
        if (btn) {
            btn.innerHTML = playing ? '<span class="play-icon">&#9632;</span>' : '<span class="play-icon">&#9654;</span>';
            btn.className = playing ? 'play-btn stop' : 'play-btn start';
        }
    } else {
        const status = document.getElementById('clientPlayStatus');
        if (status) {
            const text = status.querySelector('span:last-child');
            if (playing) {
                status.classList.add('playing');
                if (text) text.textContent = 'Playing';
            } else {
                status.classList.remove('playing');
                if (text) text.textContent = 'Standby';
            }
        }
    }
}

// タッチイベントでのAudioContext再開
document.addEventListener('touchstart', async () => {
    if (audioContext && audioContext.state === 'suspended') {
        showDebug('タッチイベント: AudioContext再開試行');
        await audioContext.resume();
        showDebug(`AudioContext状態: ${audioContext.state}`);
    }
}, { passive: false });

document.addEventListener('click', async () => {
    if (audioContext && audioContext.state === 'suspended') {
        showDebug('クリックイベント: AudioContext再開試行');
        await audioContext.resume();
        showDebug(`AudioContext状態: ${audioContext.state}`);
    }
});

// 初期ロード時のオフライン状態反映
updateOnlineStatus();

// テザリングヘルプモーダル
function toggleHelp() {
    const modal = document.getElementById('helpModal');
    if (modal) {
        modal.classList.toggle('active');
    }
}
window.toggleHelp = toggleHelp;
