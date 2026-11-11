// Player Interface JavaScript
let socket;
let playerUuid = null;
let selectedPlayerCards = [];
let myCards = [];
let gameActive = false;
let drawnNumbers = [];
let currentSession = null;
let audioPlayer = document.getElementById('playerAudio');
let currentBingoCard = null;

// Join Game
async function joinGame() {
    const gameId = document.getElementById('gameId').value.trim();
    const phoneNumber = document.getElementById('phoneNumber').value.trim();
    const playerName = document.getElementById('playerName').value.trim();
    
    if (!gameId || !phoneNumber || !playerName) {
        Swal.fire('Error', 'Please fill all fields', 'error');
        return;
    }
    
    if (!/^\d{10}$/.test(phoneNumber.replace(/\D/g, ''))) {
        Swal.fire('Invalid Phone', 'Please enter a valid phone number', 'error');
        return;
    }
    
    Swal.fire({
        title: 'Joining Game...',
        text: 'Please wait while we connect you',
        allowOutsideClick: false,
        didOpen: () => {
            Swal.showLoading();
        }
    });
    
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        socket.emit('request_remote_join', {
            gameId,
            phoneNumber,
            playerName
        });
    });
    
    socket.on('request_sent', (data) => {
        playerUuid = data.playerUuid;
        Swal.fire({
            title: 'Request Sent!',
            text: 'Waiting for agent approval...',
            icon: 'info',
            timer: 3000,
            showConfirmButton: false
        });
        addPlayerMessage('Join request sent to agent. Please wait for approval...', 'info');
    });
    
    socket.on('join_approved', (data) => {
        currentSession = data.sessionId;
        document.getElementById('joinFormContainer').style.display = 'none';
        document.getElementById('gameInterface').style.display = 'block';
        loadAvailableCards();
        startGameSync();
        Swal.fire({
            title: 'Approved! 🎉',
            text: 'You have successfully joined the game!',
            icon: 'success',
            timer: 2000,
            showConfirmButton: false
        });
        addPlayerMessage('Welcome to the game! Select your cards to start playing.', 'success');
    });
    
    socket.on('join_rejected', () => {
        Swal.fire({
            title: 'Request Rejected',
            text: 'Your request was rejected by the agent',
            icon: 'error',
            confirmButtonText: 'OK'
        });
        addPlayerMessage('Your request was rejected by the agent', 'error');
    });
    
    socket.on('game_state', (data) => {
        drawnNumbers = data.drawnNumbers;
        gameActive = data.gameActive;
        updateMyCards();
        if (gameActive) {
            document.getElementById('bingoButton').style.display = 'block';
        }
    });
    
    socket.on('number_drawn', (data) => {
        addToDrawHistory(data);
        drawnNumbers.push(parseInt(data.number));
        updateMyCards();
        playNumberSound(data);
        addPlayerMessage(`Number called: ${data.numberText}`, 'info');
    });
    
    socket.on('game_ended', (data) => {
        gameActive = false;
        document.getElementById('bingoButton').style.display = 'none';
        Swal.fire({
            title: 'Game Ended',
            html: `Winner: Card #${data.winner}<br>Prize: ${data.prize} ETB`,
            icon: 'info',
            confirmButtonText: 'OK'
        });
        addPlayerMessage(`Game ended! Winner: Card #${data.winner}`, 'warning');
    });
}

// Load Available Cards
async function loadAvailableCards() {
    try {
        const response = await fetch('/api/cards');
        const cards = await response.json();
        
        const bookedResponse = await fetch(`/api/booked-cards/${currentSession}`);
        const bookedCards = await bookedResponse.json();
        
        const grid = document.getElementById('playerCardGrid');
        grid.innerHTML = '';
        
        cards.forEach(card => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'player-card-item';
            
            if (bookedCards.includes(card.number)) {
                cardDiv.classList.add('disabled');
                cardDiv.innerHTML = `${card.number}<br><small>Booked</small>`;
                cardDiv.style.cursor = 'not-allowed';
            } else {
                cardDiv.textContent = card.number;
                cardDiv.onclick = () => togglePlayerCard(card.number, cardDiv);
            }
            grid.appendChild(cardDiv);
        });
        
        document.getElementById('selectedPlayerCardsCount').textContent = selectedPlayerCards.length;
    } catch (error) {
        console.error('Error loading cards:', error);
        addPlayerMessage('Error loading cards', 'error');
    }
}

// Toggle Player Card Selection
function togglePlayerCard(cardNumber, element) {
    if (selectedPlayerCards.includes(cardNumber)) {
        selectedPlayerCards = selectedPlayerCards.filter(c => c !== cardNumber);
        element.classList.remove('selected');
    } else {
        if (selectedPlayerCards.length < 10) {
            selectedPlayerCards.push(cardNumber);
            element.classList.add('selected');
        } else {
            Swal.fire('Limit Reached', 'Maximum 10 cards per player', 'warning');
        }
    }
    document.getElementById('selectedPlayerCardsCount').textContent = selectedPlayerCards.length;
}

// Submit Cards
async function submitCards() {
    if (selectedPlayerCards.length === 0) {
        Swal.fire('Error', 'Please select at least one card', 'error');
        return;
    }
    
    Swal.fire({
        title: 'Submitting Cards...',
        text: 'Please wait',
        allowOutsideClick: false,
        didOpen: () => {
            Swal.showLoading();
        }
    });
    
    try {
        const response = await fetch('/api/submit-cards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSession,
                playerUuid: playerUuid,
                cards: selectedPlayerCards
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            myCards = [...selectedPlayerCards];
            document.getElementById('cardsSelection').style.display = 'none';
            document.getElementById('myCards').style.display = 'block';
            displayMyCards();
            Swal.fire({
                title: 'Success!',
                text: `${selectedPlayerCards.length} card(s) submitted and approved!`,
                icon: 'success',
                timer: 2000,
                showConfirmButton: false
            });
            addPlayerMessage(`${selectedPlayerCards.length} cards approved! Good luck!`, 'success');
        } else {
            Swal.fire('Error', result.message, 'error');
            loadAvailableCards(); // Reload to update booked status
        }
    } catch (error) {
        console.error('Error submitting cards:', error);
        Swal.fire('Error', 'Failed to submit cards', 'error');
    }
}

// Display My Cards
async function displayMyCards() {
    const container = document.getElementById('playerCards');
    container.innerHTML = '';
    
    for (const cardNumber of myCards) {
        try {
            const response = await fetch(`/api/card/${cardNumber}`);
            const cardData = await response.json();
            
            const cardDiv = document.createElement('div');
            cardDiv.className = 'player-card-view';
            cardDiv.id = `card-${cardNumber}`;
            cardDiv.innerHTML = `
                <h5>Card #${cardNumber}</h5>
                ${renderPlayerCardTable(cardData, cardNumber)}
                <button class="btn btn-warning btn-sm mt-2 w-100" onclick="checkThisCard(${cardNumber})">
                    <i class="fas fa-search"></i> Check This Card
                </button>
            `;
            container.appendChild(cardDiv);
        } catch (error) {
            console.error('Error loading card:', error);
        }
    }
}

// Render Player Card Table
function renderPlayerCardTable(cardData, cardNumber) {
    let html = '<table class="player-card-table">';
    html += '<tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr>';
    
    for (let row = 0; row < 5; row++) {
        html += '<tr>';
        for (let letter of ['B', 'I', 'N', 'G', 'O']) {
            let value = cardData[letter][row];
            const isDrawn = value !== 'FREE' && drawnNumbers.includes(parseInt(value));
            const markedClass = isDrawn ? 'marked' : '';
            html += `<td class="${markedClass}">${value}</td>`;
        }
        html += '</tr>';
    }
    
    html += '</table>';
    return html;
}

// Update My Cards
function updateMyCards() {
    myCards.forEach(async cardNumber => {
        const cardDiv = document.getElementById(`card-${cardNumber}`);
        if (cardDiv) {
            try {
                const response = await fetch(`/api/card/${cardNumber}`);
                const cardData = await response.json();
                const tableHtml = renderPlayerCardTable(cardData, cardNumber);
                cardDiv.innerHTML = `
                    <h5>Card #${cardNumber}</h5>
                    ${tableHtml}
                    <button class="btn btn-warning btn-sm mt-2 w-100" onclick="checkThisCard(${cardNumber})">
                        <i class="fas fa-search"></i> Check This Card
                    </button>
                `;
                
                // Check if this card is a winner
                await checkCardWinner(cardNumber);
            } catch (error) {
                console.error('Error updating card:', error);
            }
        }
    });
}

// Check Card Winner
async function checkCardWinner(cardNumber) {
    try {
        const response = await fetch('/api/check-card-winner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cardNumber,
                drawnNumbers,
                sessionId: currentSession
            })
        });
        
        const result = await response.json();
        
        if (result.isWinner) {
            currentBingoCard = cardNumber;
            const cardDiv = document.getElementById(`card-${cardNumber}`);
            cardDiv.style.border = '3px solid #ffc107';
            cardDiv.style.boxShadow = '0 0 20px rgba(255,193,7,0.5)';
            document.getElementById('bingoButton').style.display = 'block';
            addPlayerMessage(`🎯 Card #${cardNumber} has a winning pattern! Click BINGO!`, 'success');
            playSound('message_3');
        }
    } catch (error) {
        console.error('Error checking winner:', error);
    }
}

// Check This Card
async function checkThisCard(cardNumber) {
    Swal.fire({
        title: 'Checking Card...',
        text: `Checking card #${cardNumber}`,
        allowOutsideClick: false,
        didOpen: () => {
            Swal.showLoading();
        }
    });
    
    try {
        const response = await fetch('/api/check-card-winner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cardNumber,
                drawnNumbers,
                sessionId: currentSession
            })
        });
        
        const result = await response.json();
        
        if (result.isWinner) {
            Swal.fire({
                title: '🎉 WINNER! 🎉',
                html: `Card #${cardNumber} is a winner!<br>Click the BINGO button to claim your prize!`,
                icon: 'success',
                confirmButtonText: 'Claim Prize'
            }).then(() => {
                claimBingo(cardNumber);
            });
            playSound('message_2');
        } else {
            Swal.fire({
                title: 'Not a Winner',
                text: `Card #${cardNumber} does not have a winning pattern yet`,
                icon: 'info',
                confirmButtonText: 'OK'
            });
            playSound('message_5');
        }
    } catch (error) {
        console.error('Error checking card:', error);
        Swal.fire('Error', 'Failed to check card', 'error');
    }
}

// Claim Bingo
async function claimBingo(cardNumber = null) {
    const bingoCard = cardNumber || currentBingoCard;
    
    if (!bingoCard) {
        Swal.fire('Error', 'No winning card selected', 'error');
        return;
    }
    
    Swal.fire({
        title: 'Claiming BINGO!',
        text: 'Processing your win...',
        allowOutsideClick: false,
        didOpen: () => {
            Swal.showLoading();
        }
    });
    
    try {
        const response = await fetch('/api/claim-bingo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cardNumber: bingoCard,
                playerUuid,
                sessionId: currentSession,
                drawnNumbers
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            Swal.fire({
                title: '🎉 CONGRATULATIONS! 🎉',
                html: `
                    <div style="text-align: center;">
                        <h2 class="text-success">BINGO!</h2>
                        <p>You've won <strong class="text-danger">${result.prizeAmount.toFixed(2)} ETB</strong>!</p>
                        <p>Winning Patterns:</p>
                        <ul>
                            ${result.patterns.map(p => `<li>🏆 ${p}</li>`).join('')}
                        </ul>
                    </div>
                `,
                icon: 'success',
                confirmButtonText: 'AMAZING! 🎊'
            });
            playSound('message_2');
            document.getElementById('bingoButton').style.display = 'none';
            addPlayerMessage(`🎉 BINGO! You won ${result.prizeAmount} ETB! 🎉`, 'success');
        } else {
            Swal.fire({
                title: 'Claim Failed',
                text: result.message,
                icon: 'error',
                confirmButtonText: 'OK'
            });
            playSound('message_5');
        }
    } catch (error) {
        console.error('Error claiming bingo:', error);
        Swal.fire('Error', 'Failed to claim bingo', 'error');
    }
}

// Add to Draw History
function addToDrawHistory(data) {
    const container = document.getElementById('drawHistoryScroll');
    const item = document.createElement('div');
    item.className = 'draw-history-item';
    item.textContent = data.numberText;
    container.appendChild(item);
    
    // Auto scroll to show new item
    container.scrollLeft = container.scrollWidth;
    
    // Update current call display
    document.getElementById('currentCall').innerHTML = `
        <div class="call-letter">${data.letter}</div>
        <div class="call-number">${data.number}</div>
    `;
}

// Play Number Sound
function playNumberSound(data) {
    const soundFile = `${data.numberText}.wav`;
    playSound(soundFile);
}

// Play Sound
function playSound(fileName) {
    if (!audioPlayer) {
        audioPlayer = document.getElementById('playerAudio');
    }
    audioPlayer.src = `/audio/${fileName}`;
    audioPlayer.play().catch(e => console.log('Audio play error:', e));
}

// Add Player Message
function addPlayerMessage(message, type) {
    const container = document.getElementById('drawHistoryScroll');
    const msgDiv = document.createElement('div');
    msgDiv.className = `alert alert-${type} alert-sm m-1 p-1`;
    msgDiv.textContent = message;
    container.appendChild(msgDiv);
    setTimeout(() => msgDiv.remove(), 3000);
}

// Start Game Sync
function startGameSync() {
    setInterval(async () => {
        if (currentSession && gameActive) {
            try {
                const response = await fetch(`/api/game-state/${currentSession}`);
                const state = await response.json();
                if (state.drawnNumbers.length !== drawnNumbers.length) {
                    drawnNumbers = state.drawnNumbers;
                    updateMyCards();
                }
                gameActive = state.gameActive;
            } catch (error) {
                console.error('Error syncing game state:', error);
            }
        }
    }, 2000);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('Player interface loaded');
});