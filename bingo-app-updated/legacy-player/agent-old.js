// Agent Dashboard JavaScript
let socket;
let currentSession = null;
let currentGameId = null;
let selectedCards = [];
let gameActive = false;
let gamePaused = false;
let drawnNumbers = [];
let audioPlayer = document.getElementById('audioPlayer');
let currentJackpot = 0;
let currentPrizePool = 0;

// Initialize Socket Connection
function initSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        addNotification('Connected to server', 'success');
        createGameSession();
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        addNotification('Disconnected from server!', 'danger');
        gameActive = false;
        updateButtonStates();
    });
    
    socket.on('session_created', (data) => {
        currentSession = data.sessionId;
        currentGameId = data.gameId;
        document.getElementById('gameIdDisplay').textContent = `Game ID: ${data.gameId}`;
        socket.emit('agent_join', currentSession);
        loadCards();
        Swal.fire({
            icon: 'success',
            title: 'Game Session Created!',
            html: `Game ID: <strong>${data.gameId}</strong><br>Share this ID with players to join`,
            timer: 3000,
            showConfirmButton: true
        });
        addNotification(`Game session created. ID: ${data.gameId}`, 'success');
    });
    
    socket.on('game_started', (data) => {
        gameActive = true;
        currentPrizePool = data.prizePool;
        currentJackpot = data.jackpot;
        updateStats();
        updateButtonStates();
        Swal.fire({
            icon: 'success',
            title: 'Game Started!',
            html: `Prize Pool: ${data.prizePool.toFixed(2)} ETB<br>Jackpot: ${data.jackpot.toFixed(2)} ETB`,
            timer: 3000,
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: '#fff'
        });
        playSound('message_4');
        addNotification('Game started! Good luck everyone!', 'success');
    });
    
    socket.on('number_drawn', (data) => {
        addToDrawHistory(data);
        markNumberOnBoard(data);
        playNumberSound(data);
        updateCurrentDisplay(data);
        updateStats();
        addNotification(`Number called: ${data.numberText}`, 'info');
    });
    
    socket.on('potential_winners', (data) => {
        addNotification(`⚠️ Potential winners on cards: ${data.cards.join(', ')}`, 'warning');
        Swal.fire({
            icon: 'warning',
            title: 'Potential Winners!',
            html: `Cards <strong>${data.cards.join(', ')}</strong> have winning patterns.<br>Click "Check Card" within ${data.timer/1000} seconds!`,
            timer: data.timer,
            showConfirmButton: true,
            confirmButtonText: 'Check Now',
            didClose: () => {
                document.getElementById('checkBtn').click();
            }
        });
    });
    
    socket.on('winner_timeout', (data) => {
        addNotification(`Timeout! Winners on cards ${data.cards.join(', ')} missed!`, 'danger');
        Swal.fire({
            icon: 'error',
            title: 'Time\'s Up!',
            text: data.message,
            timer: 3000
        });
    });
    
    socket.on('winner_found', (data) => {
        gameActive = false;
        updateButtonStates();
        showWinnerCard(data);
        playSound('message_2');
        addNotification(`🎉 WINNER! Card ${data.cardNumber} wins ${data.prizeAmount} ETB!`, 'success');
        updateStats();
    });
    
    socket.on('game_ended', (data) => {
        gameActive = false;
        gamePaused = false;
        updateButtonStates();
        Swal.fire({
            icon: 'info',
            title: 'Game Ended',
            html: `Final Jackpot: ${data.jackpot.toFixed(2)} ETB<br>Reason: ${data.reason}`,
            confirmButtonText: 'OK'
        });
        addNotification(`Game ended: ${data.reason}`, 'info');
    });
    
    socket.on('game_paused', () => {
        gamePaused = true;
        document.getElementById('pausePlayBtn').innerHTML = '<i class="fas fa-play"></i> Play';
        addNotification('Game paused by agent', 'warning');
    });
    
    socket.on('game_resumed', () => {
        gamePaused = false;
        document.getElementById('pausePlayBtn').innerHTML = '<i class="fas fa-pause"></i> Pause';
        addNotification('Game resumed', 'success');
    });
    
    socket.on('game_stopped', () => {
        gameActive = false;
        gamePaused = false;
        updateButtonStates();
        addNotification('Game stopped by agent', 'danger');
        Swal.fire('Game Stopped', 'The game has been stopped', 'info');
    });
    
    socket.on('game_reset', () => {
        gameActive = false;
        gamePaused = false;
        selectedCards = [];
        drawnNumbers = [];
        document.getElementById('selectedCount').textContent = '0';
        document.getElementById('drawHistory').innerHTML = '';
        initializeNumberBoard();
        loadCards();
        updateButtonStates();
        addNotification('Game has been reset', 'info');
    });
    
    socket.on('join_request', (data) => {
        showJoinRequest(data);
    });
    
    socket.on('player_approved', (data) => {
        addNotification(`✅ Player ${data.player_name} has joined the game!`, 'success');
        updateRemotePlayers();
    });
    
    socket.on('check_result', (data) => {
        if (data.success) {
            Swal.fire({
                icon: 'success',
                title: 'Winner Check Result',
                html: `✅ Card ${data.cardNumber} is a WINNER!<br>Prize: ${data.prizeAmount} ETB<br>Patterns: ${data.patterns.join(', ')}`,
                confirmButtonText: 'Great!'
            });
            playSound('message_2');
        } else {
            Swal.fire({
                icon: 'error',
                title: 'Not a Winner',
                text: data.message,
                confirmButtonText: 'OK'
            });
            playSound('message_5');
        }
    });
}

// Create Game Session
function createGameSession() {
    socket.emit('create_game_session');
}

// Load Cards
async function loadCards() {
    try {
        const response = await fetch('/api/cards');
        const cards = await response.json();
        
        const grid = document.getElementById('cardGrid');
        grid.innerHTML = '';
        
        cards.forEach(card => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'card-item';
            cardDiv.textContent = card.number;
            cardDiv.onclick = () => toggleCardSelection(card.number, cardDiv);
            grid.appendChild(cardDiv);
        });
    } catch (error) {
        console.error('Error loading cards:', error);
        addNotification('Error loading cards', 'danger');
    }
}

// Toggle Card Selection
function toggleCardSelection(cardNumber, element) {
    if (gameActive) {
        Swal.fire('Game Active', 'Cannot change cards during active game', 'warning');
        return;
    }
    
    const index = selectedCards.indexOf(cardNumber);
    if (index === -1) {
        selectedCards.push(cardNumber);
        element.classList.add('selected');
    } else {
        selectedCards.splice(index, 1);
        element.classList.remove('selected');
    }
    
    document.getElementById('selectedCount').textContent = selectedCards.length;
}

// Start Game
async function startGame() {
    if (gameActive) {
        Swal.fire('Game Active', 'Game is already running', 'warning');
        return;
    }
    
    if (selectedCards.length < 5) {
        Swal.fire('Invalid Selection', 'Please select at least 5 cards to start the game', 'error');
        return;
    }
    
    const { value: stackAmount } = await Swal.fire({
        title: 'Enter Stack Amount',
        text: `Selected Cards: ${selectedCards.length}`,
        input: 'select',
        inputOptions: {
            20: '20 ETB',
            50: '50 ETB',
            100: '100 ETB',
            200: '200 ETB',
            300: '300 ETB',
            500: '500 ETB',
            1000: '1000 ETB'
        },
        inputPlaceholder: 'Select stack amount per card',
        showCancelButton: true,
        confirmButtonText: 'Start Game',
        cancelButtonText: 'Cancel'
    });
    
    if (stackAmount) {
        const totalStack = stackAmount * selectedCards.length;
        const prizePool = totalStack * 0.8;
        const agentCommission = totalStack * 0.2;
        
        const confirm = await Swal.fire({
            title: 'Confirm Game Start',
            html: `
                <div style="text-align: left;">
                    <p><strong>Game Configuration:</strong></p>
                    <hr>
                    <p>📊 Stack Amount per Card: <strong>${stackAmount} ETB</strong></p>
                    <p>🎴 Selected Cards: <strong>${selectedCards.length}</strong></p>
                    <p>💰 Total Stack: <strong>${totalStack} ETB</strong></p>
                    <hr>
                    <p>🏆 Prize Pool (80%): <strong class="text-success">${prizePool.toFixed(2)} ETB</strong></p>
                    <p>👤 Agent Commission (20%): <strong class="text-info">${agentCommission.toFixed(2)} ETB</strong></p>
                    <hr>
                    <p>🎰 Current Jackpot: <strong class="text-warning">${currentJackpot.toFixed(2)} ETB</strong></p>
                    <p>🏅 Total Prize: <strong class="text-danger">${(prizePool + currentJackpot).toFixed(2)} ETB</strong></p>
                </div>
            `,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: '✅ Start Game',
            cancelButtonText: '❌ Cancel',
            confirmButtonColor: '#28a745'
        });
        
        if (confirm.isConfirmed) {
            socket.emit('start_game', {
                sessionId: currentSession,
                stackAmount: parseInt(stackAmount),
                selectedCards: selectedCards,
                gameId: currentGameId
            });
        }
    }
}

// Toggle Pause/Play
function togglePausePlay() {
    if (!gameActive) return;
    
    if (gamePaused) {
        socket.emit('resume_game');
    } else {
        socket.emit('pause_game');
    }
}

// Stop Game
function stopGame() {
    Swal.fire({
        title: 'Stop Game?',
        text: 'Are you sure you want to stop the current game? This cannot be undone.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, stop game',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#dc3545'
    }).then((result) => {
        if (result.isConfirmed) {
            socket.emit('stop_game');
            addNotification('Game stopped by agent', 'danger');
        }
    });
}

// Reset Game
function resetGame() {
    Swal.fire({
        title: 'Reset Game?',
        text: 'This will clear all game data and reset the board. Are you sure?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, reset',
        cancelButtonText: 'No',
        confirmButtonColor: '#dc3545'
    }).then((result) => {
        if (result.isConfirmed) {
            socket.emit('reset_game');
            selectedCards = [];
            drawnNumbers = [];
            document.getElementById('selectedCount').textContent = '0';
            document.getElementById('drawHistory').innerHTML = '';
            initializeNumberBoard();
            loadCards();
            addNotification('Game has been reset', 'info');
            Swal.fire('Reset Complete', 'Game has been reset successfully', 'success');
        }
    });
}

// Show Check Card Dialog
async function showCheckCardDialog() {
    if (!gameActive) {
        Swal.fire('Game Not Active', 'Please start a game first', 'warning');
        return;
    }
    
    const { value: cardNumber } = await Swal.fire({
        title: 'Check Card',
        input: 'number',
        inputLabel: 'Enter card number to check (1-100)',
        inputPlaceholder: 'Card number',
        showCancelButton: true,
        confirmButtonText: 'Check',
        inputValidator: (value) => {
            if (!value || value < 1 || value > 100) {
                return 'Please enter a valid card number (1-100)';
            }
        }
    });
    
    if (cardNumber) {
        addNotification(`Checking card #${cardNumber}...`, 'info');
        socket.emit('check_card', { cardNumber: parseInt(cardNumber) });
    }
}

// Show Winner Card
function showWinnerCard(data) {
    const cardHTML = renderCardTable(data.cardData, true);
    
    Swal.fire({
        title: '🎉 BINGO! WINNER! 🎉',
        html: `
            <div style="text-align: center;">
                <h2 class="text-success mb-3">Card #${data.cardNumber}</h2>
                <div class="alert alert-success">
                    <strong>Prize Amount: ${data.prizeAmount.toFixed(2)} ETB</strong>
                </div>
                <div class="alert alert-info">
                    <strong>Winning Patterns:</strong><br>
                    ${data.patterns.map(p => `🏆 ${p}`).join('<br>')}
                </div>
                ${cardHTML}
            </div>
        `,
        icon: 'success',
        confirmButtonText: 'Awesome! 🎊',
        confirmButtonColor: '#28a745',
        width: '800px'
    });
}

// Render Card Table
function renderCardTable(cardData, showMarked = false) {
    let html = '<table class="card-table table table-bordered">';
    html += '<thead><tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr></thead><tbody>';
    
    for (let row = 0; row < 5; row++) {
        html += '<tr>';
        for (let letter of ['B', 'I', 'N', 'G', 'O']) {
            let value = cardData[letter][row];
            const isDrawn = value !== 'FREE' && drawnNumbers.includes(parseInt(value));
            const markedClass = (showMarked && isDrawn) ? 'marked bg-success text-white' : '';
            html += `<td class="${markedClass}">${value}</td>`;
        }
        html += '</tr>';
    }
    
    html += '</tbody></table>';
    return html;
}

// Update Current Display
function updateCurrentDisplay(data) {
    const display = document.getElementById('currentNumber');
    display.querySelector('.number-letter').textContent = data.letter;
    display.querySelector('.number-value').textContent = data.number;
    display.style.animation = 'none';
    setTimeout(() => {
        display.style.animation = 'pulse 2s infinite';
    }, 10);
}

// Add to Draw History
function addToDrawHistory(data) {
    const history = document.getElementById('drawHistory');
    const item = document.createElement('div');
    item.className = 'draw-history-item';
    item.textContent = data.numberText;
    history.insertBefore(item, history.firstChild);
    
    if (history.children.length > 20) {
        history.removeChild(history.lastChild);
    }
}

// Mark Number on Board
function markNumberOnBoard(data) {
    const board = document.getElementById('numbersBoard');
    const cells = board.querySelectorAll('.number-cell');
    
    for (let cell of cells) {
        const cellText = cell.textContent;
        if (cellText === data.numberText) {
            cell.classList.add('drawn');
            break;
        }
    }
}

// Play Number Sound
function playNumberSound(data) {
    const soundFile = `${data.numberText}.wav`;
    playSound(soundFile);
}

// Play Sound
function playSound(fileName) {
    if (!audioPlayer) {
        audioPlayer = document.getElementById('audioPlayer');
    }
    audioPlayer.src = `/audio/${fileName}`;
    audioPlayer.play().catch(e => console.log('Audio play error:', e));
}

// Initialize Number Board
function initializeNumberBoard() {
    const board = document.getElementById('numbersBoard');
    board.innerHTML = '';
    
    const columns = ['B', 'I', 'N', 'G', 'O'];
    const ranges = [
        { min: 1, max: 15 },
        { min: 16, max: 30 },
        { min: 31, max: 45 },
        { min: 46, max: 60 },
        { min: 61, max: 75 }
    ];
    
    for (let colIndex = 0; colIndex < columns.length; colIndex++) {
        const columnDiv = document.createElement('div');
        columnDiv.className = 'col';
        
        for (let num = ranges[colIndex].min; num <= ranges[colIndex].max; num++) {
            const numberDiv = document.createElement('div');
            numberDiv.className = 'number-cell';
            numberDiv.textContent = `${columns[colIndex]}${num}`;
            columnDiv.appendChild(numberDiv);
        }
        
        board.appendChild(columnDiv);
    }
}

// Update Button States
function updateButtonStates() {
    const startBtn = document.getElementById('startBtn');
    const pausePlayBtn = document.getElementById('pausePlayBtn');
    const stopBtn = document.getElementById('stopBtn');
    const resetBtn = document.getElementById('resetBtn');
    const checkBtn = document.getElementById('checkBtn');
    
    startBtn.disabled = gameActive;
    pausePlayBtn.disabled = !gameActive;
    stopBtn.disabled = !gameActive;
    resetBtn.disabled = gameActive;
    checkBtn.disabled = !gameActive;
}

// Add Notification
function addNotification(message, type) {
    const container = document.getElementById('notifications');
    const notification = document.createElement('div');
    const icons = {
        success: 'fa-check-circle',
        danger: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    notification.className = `notification-item alert alert-${type} alert-dismissible fade show`;
    notification.innerHTML = `
        <i class="fas ${icons[type] || 'fa-bell'}"></i>
        <strong>${message}</strong>
        <small class="text-muted d-block mt-1">${new Date().toLocaleTimeString()}</small>
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    container.insertBefore(notification, container.firstChild);
    
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

// Show Join Request
function showJoinRequest(data) {
    Swal.fire({
        title: 'New Player Request',
        html: `
            <div style="text-align: left;">
                <p><strong>Player Name:</strong> ${data.playerName}</p>
                <p><strong>Phone Number:</strong> ${data.phoneNumber}</p>
                <p><strong>Request Time:</strong> ${new Date().toLocaleTimeString()}</p>
            </div>
        `,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: '✅ Approve',
        cancelButtonText: '❌ Reject',
        confirmButtonColor: '#28a745',
        cancelButtonColor: '#dc3545'
    }).then((result) => {
        socket.emit('approve_player', {
            playerUuid: data.playerUuid,
            approved: result.isConfirmed
        });
        
        if (result.isConfirmed) {
            addNotification(`Approved player: ${data.playerName}`, 'success');
        } else {
            addNotification(`Rejected player: ${data.playerName}`, 'danger');
        }
    });
}

// Update Remote Players List
async function updateRemotePlayers() {
    try {
        const response = await fetch(`/api/remote-players/${currentSession}`);
        const players = await response.json();
        
        const container = document.getElementById('remotePlayers');
        container.innerHTML = '';
        
        if (players.length === 0) {
            container.innerHTML = '<p class="text-muted text-center">No remote players yet</p>';
            return;
        }
        
        players.forEach(player => {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'remote-player-item';
            playerDiv.innerHTML = `
                <div class="remote-player-info">
                    <div class="remote-player-name">${player.player_name}</div>
                    <div class="remote-player-phone">${player.phone_number}</div>
                    <small class="text-muted">Joined: ${new Date(player.joined_at).toLocaleTimeString()}</small>
                </div>
                <span class="badge bg-${player.status === 'active' ? 'success' : 'warning'}">${player.status}</span>
            `;
            container.appendChild(playerDiv);
        });
    } catch (error) {
        console.error('Error updating remote players:', error);
    }
}

// Update Stats
function updateStats() {
    document.getElementById('statsCardsInPlay').textContent = selectedCards.length;
    document.getElementById('statsNumbersCalled').textContent = drawnNumbers.length;
    document.getElementById('jackpotDisplay').textContent = currentJackpot.toFixed(2);
    document.getElementById('prizePoolDisplay').textContent = currentPrizePool.toFixed(2);
}

// Show Configuration
async function showConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        const { value: formValues } = await Swal.fire({
            title: 'Game Configuration',
            html: `
                <div class="mb-3">
                    <label class="form-label">Jackpot Minimum Limit (ETB)</label>
                    <input id="jackpotMin" class="form-control" value="${config.jackpot_min_limit}" type="number" step="100">
                </div>
                <div class="mb-3">
                    <label class="form-label">Draw Interval (seconds)</label>
                    <input id="drawInterval" class="form-control" value="${config.draw_interval}" type="number" min="1" max="10">
                </div>
                <div class="alert alert-info">
                    <small>Changes will take effect in the next game session</small>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: 'Save Changes',
            preConfirm: () => {
                return {
                    jackpot_min_limit: document.getElementById('jackpotMin').value,
                    draw_interval: document.getElementById('drawInterval').value
                };
            }
        });
        
        if (formValues) {
            const updateResponse = await fetch('/api/update-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formValues)
            });
            
            if (updateResponse.ok) {
                Swal.fire('Success!', 'Configuration updated successfully', 'success');
                addNotification('Game configuration updated', 'success');
            } else {
                Swal.fire('Error', 'Failed to update configuration', 'error');
            }
        }
    } catch (error) {
        console.error('Error loading config:', error);
        Swal.fire('Error', 'Failed to load configuration', 'error');
    }
}

// Load Game State Periodically
setInterval(async () => {
    if (currentSession && !gameActive) {
        try {
            const response = await fetch(`/api/game-state/${currentSession}`);
            const state = await response.json();
            drawnNumbers = state.drawnNumbers;
            updateStats();
        } catch (error) {
            console.error('Error updating game state:', error);
        }
    }
}, 5000);

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initSocket();
    initializeNumberBoard();
    updateButtonStates();
});