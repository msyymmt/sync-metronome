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

// 役割選択
function selectRole(selectedRole) {
    role = selectedRole;
    initAudio();

    document.getElementById('roleSelection').classList.remove('active');

    if (role === 'host') {
        document.getElementById('hostScreen').classList.add('active');
        connectSocket(() => {
            showDebug('ホストとしてルーム作成中...');
            socket.emit('createRoom', { hostName: 'ホスト' });
        });
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
    });

    socket.on('disconnect', (reason) => {
        showDebug(`⚠️ 切断されました: ${reason}`);
    });

    // 時刻同期開始
    calculateOffset();

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

// 時刻同期処理 (NTPライク)
async function calculateOffset() {
    showDebug('時刻同期を開始します...');
    const samples = [];

    // 5回計測してRTTが最小のものを採用
    for (let i = 0; i < 5; i++) {
        const result = await new Promise(resolve => {
            const t0 = Date.now();
            socket.emit('syncPing', { clientTime: t0 });

            socket.once('syncPong', (data) => {
                const t1 = Date.now();
                const rtt = t1 - t0;
                // サーバー時刻 = 受信時のサーバー時刻 + 行きの通信時間(RTT/2)
                const estimatedServerTime = data.serverTime + (rtt / 2);
                const offset = estimatedServerTime - t1;
                resolve({ rtt, offset });
            });

            // タイムアウト設定(1秒)
            setTimeout(() => resolve(null), 1000);
        });

        if (result) {
            samples.push(result);
            // ログは出しすぎると邪魔なので最小限に
            // showDebug(`Sync[${i}]: RTT=${result.rtt}ms Offset=${result.offset}ms`);
            await new Promise(r => setTimeout(r, 100)); // 間隔を空ける
        }
    }

    if (samples.length > 0) {
        // RTTが最小のサンプルを採用
        samples.sort((a, b) => a.rtt - b.rtt);
        const best = samples[0];
        timeOffset = best.offset;
        showDebug(`✅ 時刻同期完了: 補正値 ${timeOffset.toFixed(0)}ms (RTT: ${best.rtt}ms)`);

        // 画面にも表示
        const syncInfo = document.getElementById('syncOffset');
        if (syncInfo) syncInfo.textContent = `同期補正: ${timeOffset.toFixed(0)}ms`;
    } else {
        showDebug('⚠️ 時刻同期に失敗しました');
    }
}

// ルームリスト更新
function updateRoomList(rooms) {
    showDebug(`UI更新開始: ${rooms.length}件のデータ`);
    showDebug(`データ詳細: ${JSON.stringify(rooms)}`);

    const listElement = document.getElementById('roomList');
    listElement.innerHTML = '';

    if (rooms.length === 0) {
        listElement.innerHTML = '<div class="room-item">ルームが見つかりません</div>';
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
            <div class="client-item" style="justify-content:center; color: var(--accent-green);">
                ✅ ${count}人が接続中
            </div>
        `;
    } else {
        container.innerHTML = '<p class="waiting-text">参加者を待っています</p>';
    }
}

// 設定変更（ホストのみ）
function updateSettings(key, value) {
    if (role !== 'host') return;

    if (key === 'bpm') settings.bpm = parseInt(value);
    if (key === 'beatsPerBar') settings.beatsPerBar = parseInt(value);

    updateUI();

    // サーバーに通知
    if (socket && roomId) {
        socket.emit('updateSettings', { settings: settings });
    }
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
            statusHeader.innerHTML = '<span class="status-icon">✅</span><span>ホストに接続中</span>';
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

    // サーバー時刻を使って正確な残時間を計算
    const serverNow = Date.now() + timeOffset;
    const delay = (startTime - serverNow) / 1000;

    showDebug(`開始まで: ${delay.toFixed(3)}秒 (補正済)`);

    // WebAudioはローカル時間で動くので、delayをそのまま足せばOK
    // (delayがマイナスなら過去なので即時再生ロジックへ)
    nextNoteTime = Math.max(audioContext.currentTime + 0.05, delay + audioContext.currentTime);

    showDebug(`ローカル再生予約: ${nextNoteTime.toFixed(3)} (現在: ${audioContext.currentTime.toFixed(3)})`);

    scheduler();
    updatePlayButton(true);
}

function stopMetronome() {
    isPlaying = false;
    clearTimeout(timerID);

    // ここでの socket.emit('stop') は削除（無限ループ防止）
    // 通信は togglePlay で行う

    updatePlayButton(false);
}

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
    if (!socket) return;

    if (isPlaying) {
        socket.emit('stop'); // 停止命令を送信
        // 受信側の stop イベントで stopMetronome が呼ばれるのでここでは呼ばなくてよい
        // ただし自分自身への即時反映のために呼ぶ手もあるが、Socket.ioのブロードキャストで戻ってくるので待つのが安全
    } else {
        // スタート時はサーバーにリクエスト
        if (role === 'host') {
            socket.emit('start', {
                settings: settings,
                includeCountIn: false // カウントイン機能は後で
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
            btn.innerHTML = playing ? '<span class="play-icon">■</span><span>停止</span>' : '<span class="play-icon">▶</span><span>開始</span>';
            btn.className = playing ? 'play-btn stop' : 'play-btn start';
        }
    } else {
        const status = document.getElementById('clientPlayStatus');
        if (status) {
            const text = status.querySelector('span:last-child');
            if (playing) {
                status.classList.add('playing');
                if (text) text.textContent = '再生中';
            } else {
                status.classList.remove('playing');
                if (text) text.textContent = '待機中';
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
