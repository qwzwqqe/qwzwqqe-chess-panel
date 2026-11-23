// ==UserScript==
// @name         qwzwqqe · Chess Panel
// @namespace    qwzwqqe.chess
// @version      23.11
// @description  Плавающий шахматный блокнот Владислава. Stockfish 18 Lite, анализ по Z.
// @author       Владислав (qwzwqqe) — оформление и редакция; urs_ditch — исходный скрипт
// @license      CC BY-NC-ND 4.0
// @match        https://www.chess.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STOCKFISH_WASM_WORKER =
        'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single.js';

    let engine = null;
    let isCalculating = false;
    let isEngineReady = false;
    let currentFen = '';
    let multipvMoves = [];

    const PIECE_VALUES = {
        p: 1, n: 3.05, b: 3.33, r: 5.63, q: 9.5, k: 0
    };

    const FAST_TRAP_DATABASE = {
        'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -': 'c6d4',
        'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -': 'c4g8',
        'r1bqkb1r/ppp2ppp/2np1n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq -': 'f3e5',
        'r1bqk2r/pppp1ppp/2n2n2/4p3/1b2P3/2NP1N2/PPP2PPP/R1BQKB1R w KQkq -': 'f3e5',
        'rnbqk2r/ppp1bppp/4pn2/3p4/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq -': 'e4e5',
        'r1bqkb1r/pppp1ppp/2n5/4P3/1b6/2N2N2/PPP1PPPP/R1BQKB1R b KQkq -': 'g4e5'
    };

    const hideDefaultHighlightStyle = document.createElement('style');
    hideDefaultHighlightStyle.textContent = `
        chess-board .highlight, wc-chess-board .highlight {
            display: none !important;
            opacity: 0 !important;
        }
    `;
    (document.head || document.documentElement).appendChild(hideDefaultHighlightStyle);

    const overlayHost = document.createElement('div');
    overlayHost.id = 'app-root-' + Math.random().toString(36).substring(2, 9);
    document.documentElement.appendChild(overlayHost);

    const shadow = overlayHost.attachShadow({ mode: 'closed' });
    const styleEl = document.createElement('style');

    styleEl.textContent = `
        .status-box {
            position: fixed; right: 16px; bottom: 16px; z-index: 999999;
            box-sizing: border-box; min-width: min(184px, 95vw);
            max-width: calc(100vw - 12px); padding: 12px 15px 14px;
            display: grid; gap: 8px; cursor: grab; touch-action: none;
            user-select: none; -webkit-user-select: none;
            color: #f4edff; background: #211d29; border: 1px solid #63536f;
            border-top: 3px solid #c5a3df; box-shadow: 4px 4px #120f18;
            font: 400 10px/1.6 "Assist Pixel", monospace;
        }
        .status-box.dragging { cursor: grabbing; }
        .mast { display: flex; align-items: center; justify-content: space-between;
            gap: 16px; padding-bottom: 7px; border-bottom: 1px solid #55465f;
            color: #e6cfef; font-size: 10px; letter-spacing: 1px; }
        .mast kbd { font: inherit; font-size: 9px; padding: 1px 4px;
            border: 1px solid #796485; color: #cdb5d9; }
        .panel-label { color: #bbabc6; font-size: 8px; }
        .panel-move { font-size: 15px; }
        .panel-arrow { color: #c098db; }
        .highlight-layer { position: absolute; pointer-events: none; z-index: 9999; }
        .hl-sq { position: absolute; width: 12.5%; height: 12.5%; box-sizing: border-box; }
        .hl-std-from, .hl-std-to { --ink: #c8a4ff; }
        .hl-brilliant-from, .hl-brilliant-to { --ink: #80e0d4; }
        .hl-trap-from, .hl-trap-to { --ink: #ffd089; }
        .hl-sq { border: 2px dashed var(--ink); }
        .hl-std-to, .hl-brilliant-to, .hl-trap-to {
            border: 3px solid var(--ink);
            background: color-mix(in srgb, var(--ink) 21%, transparent);
        }
    `;
    shadow.appendChild(styleEl);

    const statusBox = document.createElement('div');
    statusBox.className = 'status-box';
    statusBox.setAttribute('role', 'status');

    const label = document.createElement('span');
    label.className = 'panel-label';
    const value = document.createElement('span');
    const mast = document.createElement('div');
    mast.className = 'mast';
    const shortcut = document.createElement('kbd');
    shortcut.textContent = 'Z';
    mast.append('qwzwqqe', shortcut);
    statusBox.append(mast, label, value);
    shadow.appendChild(statusBox);

    const positionKey = 'chess-assist.panel-position';
    let position = null;
    let drag = null;

    function placePanel() {
        if (!position) return;
        const rect = statusBox.getBoundingClientRect();
        const maxX = Math.max(0, window.innerWidth - rect.width);
        const maxY = Math.max(0, window.innerHeight - rect.height);
        statusBox.style.inset = 'auto';
        statusBox.style.left = Math.min(maxX, Math.max(0, position.x)) + 'px';
        statusBox.style.top = Math.min(maxY, Math.max(0, position.y)) + 'px';
    }

    try {
        const saved = JSON.parse(localStorage.getItem(positionKey));
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
            position = saved;
        }
    } catch {}

    placePanel();
    new ResizeObserver(placePanel).observe(statusBox);
    window.addEventListener('resize', placePanel);

    statusBox.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || drag) return;

        const rect = statusBox.getBoundingClientRect();
        drag = {
            id: event.pointerId,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top
        };

        statusBox.setPointerCapture(event.pointerId);
        statusBox.classList.add('dragging');
        event.preventDefault();
    });

    statusBox.addEventListener('pointermove', event => {
        if (event.pointerId !== drag?.id) return;
        position = {
            x: event.clientX - drag.dx,
            y: event.clientY - drag.dy
        };
        placePanel();
    });

    statusBox.addEventListener('lostpointercapture', event => {
        if (event.pointerId !== drag?.id) return;
        drag = null;
        statusBox.classList.remove('dragging');

        if (position) {
            const { left: x, top: y } = statusBox.getBoundingClientRect();
            position = { x, y };
            try {
                localStorage.setItem(positionKey, JSON.stringify(position));
            } catch {}
        }
    });

    statusBox.addEventListener('mousedown', event => event.stopPropagation());

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    shadow.appendChild(highlightLayer);

    const statusLabels = {
        'Init engine...': 'Загрузка движка…',
        'Assist ready [Z]': 'Готов к разбору',
        'Calculating...': 'Расчёт…',
        'FEN unavailable': 'Позиция недоступна',
        'Engine error': 'Ошибка загрузки',
        'No move found': 'Ход не найден'
    };

    const moveLabels = {
        Move: 'Ход',
        Brilliant: 'Жертва',
        Trap: 'Ловушка'
    };

    function setStatus(text) {
        const move = /^(Move|Brilliant|Trap): ([a-h][1-8])([a-h][1-8])([qrbn]?)$/i.exec(text);

        if (!move) {
            label.textContent = 'Stockfish 18';
            value.className = '';
            value.textContent = statusLabels[text] || text;
            return;
        }

        label.textContent = moveLabels[move[1]];
        value.className = 'panel-move';

        const arrow = document.createElement('span');
        arrow.className = 'panel-arrow';
        arrow.textContent = ' → ';

        const promotion = move[4] ? '=' + move[4].toUpperCase() : '';
        value.replaceChildren(
            move[2].toLowerCase(),
            arrow,
            move[3].toLowerCase() + promotion
        );
    }

    setStatus('Init engine...');

    function formatMoveText(prefix, move) {
        if (!move) return prefix;
        const formattedMove = move.charAt(0).toUpperCase() + move.slice(1).toLowerCase();
        return `${prefix}: ${formattedMove}`;
    }

    async function initEngine() {
        try {
            const response = await fetch(STOCKFISH_WASM_WORKER);
            if (!response.ok) throw new Error('Engine download failed');

            const wasmUrl = STOCKFISH_WASM_WORKER.replace(/\.js$/, '.wasm');
            const script = await response.text();
            const workerUrl = URL.createObjectURL(
                new Blob([script], { type: 'application/javascript' })
            );

            engine = new Worker(workerUrl + '#' + encodeURIComponent(wasmUrl));

            engine.onerror = () => {
                isCalculating = false;
                isEngineReady = false;
                setStatus('Ошибка запуска Stockfish');
                URL.revokeObjectURL(workerUrl);
            };

            engine.onmessage = event => {
                const line = event.data;
                if (line === 'uciok') {
                    engine.postMessage('setoption name Hash value 16');
                    engine.postMessage('setoption name MultiPV value 3');
                    engine.postMessage('isready');
                } else if (line === 'readyok') {
                    URL.revokeObjectURL(workerUrl);
                    isEngineReady = true;
                    setStatus('Assist ready [Z]');
                } else if (line.includes('multipv')) {
                    parseMultiPVLine(line);
                } else if (line.startsWith('bestmove')) {
                    processBestMove();
                    isCalculating = false;
                }
            };

            engine.postMessage('uci');
        } catch {
            setStatus('Engine error');
        }
    }

    function parseMultiPVLine(line) {
        const moveMatch = line.match(/pv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
        const cpMatch = line.match(/score\s+cp\s+(-?\d+)/);
        const mateMatch = line.match(/score\s+mate\s+(-?\d+)/);
        if (!moveMatch) return;

        const move = moveMatch[1];
        let score = 0;

        if (mateMatch) {
            const movesToMate = Number(mateMatch[1]);
            score = movesToMate > 0
                ? 100000 - movesToMate
                : -100000 - movesToMate;
        } else if (cpMatch) {
            score = Number(cpMatch[1]);
        }

        const existing = multipvMoves.find(item => item.move === move);
        if (existing) existing.score = score;
        else multipvMoves.push({ move, score });
    }

    function processBestMove() {
        if (!multipvMoves.length) {
            setStatus('No move found');
            return;
        }

        multipvMoves.sort((a, b) => b.score - a.score);
        let selectedMove = multipvMoves[0].move;
        let isBrilliant = false;
        const bestScore = multipvMoves[0].score;

        for (const item of multipvMoves) {
            if (bestScore - item.score <= 25 && isStrictSacrifice(item.move, currentFen)) {
                selectedMove = item.move;
                isBrilliant = true;
                break;
            }
        }

        if (isBrilliant) {
            highlightMove(selectedMove, 'hl-brilliant-from', 'hl-brilliant-to');
            setStatus(formatMoveText('Brilliant', selectedMove));
        } else {
            highlightMove(selectedMove, 'hl-std-from', 'hl-std-to');
            setStatus(formatMoveText('Move', selectedMove));
        }
    }

    function isSquareAttackedByEnemy(targetSq, enemyIsWhite, boardMap) {
        return getMinimumAttackerValue(targetSq, enemyIsWhite, boardMap) < 999;
    }

    function getMinimumAttackerValue(targetSq, enemyIsWhite, boardMap) {
        let minVal = 999;
        const file = targetSq.charCodeAt(0) - 97;
        const rank = Number(targetSq[1]);
        const enemyKingPiece = enemyIsWhite ? 'K' : 'k';
        const enemyKingSq = Object.keys(boardMap).find(sq => boardMap[sq] === enemyKingPiece);

        function isPiecePinned(fromSq) {
            if (!enemyKingSq || fromSq === enemyKingSq) return false;
            const tempMap = { ...boardMap };
            delete tempMap[fromSq];
            return isRayAttacked(enemyKingSq, !enemyIsWhite, tempMap);
        }

        const pawnPushes = enemyIsWhite ? [[-1,-1],[1,-1]] : [[-1,1],[1,1]];
        const enemyPawn = enemyIsWhite ? 'P' : 'p';
        for (const [df, dr] of pawnPushes) {
            const sq = String.fromCharCode(97 + file + df) + (rank + dr);
            if (boardMap[sq] === enemyPawn && !isPiecePinned(sq)) {
                minVal = Math.min(minVal, PIECE_VALUES.p);
            }
        }

        const knightMoves = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
        const enemyKnight = enemyIsWhite ? 'N' : 'n';
        for (const [df, dr] of knightMoves) {
            const sq = String.fromCharCode(97 + file + df) + (rank + dr);
            if (boardMap[sq] === enemyKnight && !isPiecePinned(sq)) {
                minVal = Math.min(minVal, PIECE_VALUES.n);
            }
        }

        const bishopDirections = [[1,1],[1,-1],[-1,1],[-1,-1]];
        const enemyBishop = enemyIsWhite ? 'B' : 'b';
        const enemyQueen = enemyIsWhite ? 'Q' : 'q';
        for (const [df, dr] of bishopDirections) {
            let f = file + df;
            let r = rank + dr;
            while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
                const sq = String.fromCharCode(97 + f) + r;
                const piece = boardMap[sq];
                if (piece) {
                    if ((piece === enemyBishop || piece === enemyQueen) && !isPiecePinned(sq)) {
                        minVal = Math.min(minVal, PIECE_VALUES[piece.toLowerCase()]);
                    }
                    break;
                }
                f += df;
                r += dr;
            }
        }

        const rookDirections = [[1,0],[-1,0],[0,1],[0,-1]];
        const enemyRook = enemyIsWhite ? 'R' : 'r';
        for (const [df, dr] of rookDirections) {
            let f = file + df;
            let r = rank + dr;
            while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
                const sq = String.fromCharCode(97 + f) + r;
                const piece = boardMap[sq];
                if (piece) {
                    if ((piece === enemyRook || piece === enemyQueen) && !isPiecePinned(sq)) {
                        minVal = Math.min(minVal, PIECE_VALUES[piece.toLowerCase()]);
                    }
                    break;
                }
                f += df;
                r += dr;
            }
        }

        const kingMoves = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
        for (const [df, dr] of kingMoves) {
            const sq = String.fromCharCode(97 + file + df) + (rank + dr);
            if (boardMap[sq] === enemyKingPiece) minVal = 0;
        }
        return minVal;
    }

    function isRayAttacked(targetSq, enemyIsWhite, boardMap) {
        const file = targetSq.charCodeAt(0) - 97;
        const rank = Number(targetSq[1]);
        const enemyBishop = enemyIsWhite ? 'B' : 'b';
        const enemyQueen = enemyIsWhite ? 'Q' : 'q';
        const enemyRook = enemyIsWhite ? 'R' : 'r';
        const bishopDirections = [[1,1],[1,-1],[-1,1],[-1,-1]];
        const rookDirections = [[1,0],[-1,0],[0,1],[0,-1]];

        for (const [df, dr] of bishopDirections) {
            let f = file + df;
            let r = rank + dr;
            while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
                const piece = boardMap[String.fromCharCode(97 + f) + r];
                if (piece) {
                    if (piece === enemyBishop || piece === enemyQueen) return true;
                    break;
                }
                f += df;
                r += dr;
            }
        }

        for (const [df, dr] of rookDirections) {
            let f = file + df;
            let r = rank + dr;
            while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
                const piece = boardMap[String.fromCharCode(97 + f) + r];
                if (piece) {
                    if (piece === enemyRook || piece === enemyQueen) return true;
                    break;
                }
                f += df;
                r += dr;
            }
        }
        return false;
    }

    function isStrictSacrifice(move, fen) {
        const fromSq = move.slice(0, 2);
        const toSq = move.slice(2, 4);
        const boardMap = parseFenToBoard(fen);
        const movingPiece = boardMap[fromSq];
        const targetPiece = boardMap[toSq];

        if (!movingPiece) return false;

        const isWhite = movingPiece === movingPiece.toUpperCase();
        const movingVal = PIECE_VALUES[movingPiece.toLowerCase()];
        const targetVal = targetPiece ? PIECE_VALUES[targetPiece.toLowerCase()] : 0;
        const nextBoardMap = { ...boardMap };
        delete nextBoardMap[fromSq];
        nextBoardMap[toSq] = movingPiece;

        if (targetPiece && movingVal - targetVal >= 1.8) {
            if (isSquareAttackedByEnemy(toSq, !isWhite, nextBoardMap)) return true;
        }

        if (movingVal > 1 && !targetPiece) {
            const isAttacked = isSquareAttackedByEnemy(toSq, !isWhite, nextBoardMap);
            const isDefended = isSquareAttackedByEnemy(toSq, isWhite, nextBoardMap);
            if (isAttacked && (!isDefended ||
                getMinimumAttackerValue(toSq, !isWhite, nextBoardMap) < movingVal)) {
                if (!isSquareAttackedByEnemy(fromSq, !isWhite, boardMap)) return true;
            }
        }
        return false;
    }

    function parseFenToBoard(fen) {
        const map = {};
        if (!fen) return map;

        const rows = fen.split(' ')[0].split('/');
        for (let r = 0; r < 8; r++) {
            let c = 0;
            for (const char of rows[r]) {
                if (!isNaN(char)) {
                    c += Number(char);
                } else {
                    const file = String.fromCharCode(97 + c);
                    map[file + (8 - r)] = char;
                    c++;
                }
            }
        }
        return map;
    }

    function getFEN() {
        try {
            const board = document.querySelector('chess-board, wc-chess-board');
            if (typeof board?.game?.getFEN === 'function') {
                return board.game.getFEN();
            }
            if (typeof board?.controller?.getFEN === 'function') {
                return board.controller.getFEN();
            }
            if (typeof window.chesscom?.game?.getFEN === 'function') {
                return window.chesscom.game.getFEN();
            }
        } catch {}
        return null;
    }

    function highlightMove(uciMove, classFrom, classTo) {
        removeHighlights();
        const boardNode = document.querySelector('chess-board, wc-chess-board');
        if (!boardNode) return;

        const rect = boardNode.getBoundingClientRect();
        highlightLayer.style.left = (rect.left + window.scrollX) + 'px';
        highlightLayer.style.top = (rect.top + window.scrollY) + 'px';
        highlightLayer.style.width = rect.width + 'px';
        highlightLayer.style.height = rect.height + 'px';

        createSquare(getSquareCoords(uciMove.slice(0, 2), boardNode), classFrom);
        createSquare(getSquareCoords(uciMove.slice(2, 4), boardNode), classTo);
    }

    function getSquareCoords(squareStr, boardNode) {
        const file = squareStr.charCodeAt(0) - 97;
        const rank = Number(squareStr[1]) - 1;
        const isFlipped = boardNode.classList.contains('flipped');
        return {
            col: isFlipped ? 7 - file : file,
            row: isFlipped ? rank : 7 - rank
        };
    }

    function createSquare(coords, className) {
        const square = document.createElement('div');
        square.className = 'hl-sq ' + className;
        square.style.left = (coords.col * 12.5) + '%';
        square.style.top = (coords.row * 12.5) + '%';
        highlightLayer.appendChild(square);
    }

    function removeHighlights() {
        highlightLayer.replaceChildren();
    }

    window.addEventListener('keydown', event => {
        if (event.code !== 'KeyZ' || event.repeat ||
            event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

        const active = document.activeElement;
        if (active?.matches('input, textarea') || active?.isContentEditable) return;
        if (isCalculating || !isEngineReady || !engine) return;

        removeHighlights();
        multipvMoves = [];
        currentFen = getFEN();

        if (!currentFen) {
            setStatus('FEN unavailable');
            return;
        }

        const fenShort = currentFen.split(' ').slice(0, 3).join(' ');
        const trapMove = FAST_TRAP_DATABASE[fenShort];
        if (trapMove) {
            highlightMove(trapMove, 'hl-trap-from', 'hl-trap-to');
            setStatus(formatMoveText('Trap', trapMove));
            return;
        }

        isCalculating = true;
        setStatus('Calculating...');

        const movetime = Math.floor(Math.random() * 120) + 200;
        engine.postMessage('position fen ' + currentFen);
        engine.postMessage('go movetime ' + movetime);
    });

    window.addEventListener('mousedown', removeHighlights);

    const pixelFont = new FontFace(
        'Assist Pixel',
        'url(https://fonts.gstatic.com/s/pressstart2p/v16/e3t4euO8T-267oIAQAu6jDQyK0nS.ttf)'
    );
    pixelFont.load()
        .then(font => document.fonts.add(font))
        .catch(() => {});

    initEngine();
})();