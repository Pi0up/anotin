
(function() {
    if (window.__LightAnnotatorActive) {
        window.__LightAnnotatorActive.toggle();
        return;
    }

    const LIB = {
        APP_ID: 'light-annotator-host',
        DB_NAME: 'light-annotator-db',
        DB_STORE: 'annotations',
        UI_ZINDEX: 2147483647,
        DB_VERSION: 2,
        colors: {
            yellow: 'rgba(255, 235, 59, 1)',
            green: 'rgba(76, 175, 80, 1)',
            pink: 'rgba(233, 30, 99, 1)',
            blue: 'rgba(33, 150, 243, 1)'
        }
    };

    // État global
    let state = {
        currentColor: 'yellow',
        record: null,
        // Panel Dragging
        isDragging: false,
        dragOffset: { x: 0, y: 0 },
        // Pin Dragging
        draggingPin: null, // { id, el, startX, startY, originalX, originalY, hasMoved }
        isMinimized: false
    };

    // ---------- UTILITAIRES DOM ----------
    const Utils = {
        create(tag, attrs = {}, parent = null) {
            const el = document.createElement(tag);
            for (const k in attrs) {
                if (k === 'text') el.textContent = attrs[k];
                else if (k === 'html') el.innerHTML = attrs[k];
                else if (k.startsWith('on')) el.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
                else el.setAttribute(k, attrs[k]);
            }
            if (parent) parent.appendChild(el);
            return el;
        },
        nowIso: () => (new Date()).toISOString(),
        generateId: () => 'ann_' + Math.random().toString(36).substr(2, 9),
        
        async hashString(s) {
            if (!window.crypto || !window.crypto.subtle) return Math.random().toString(36);
            const enc = new TextEncoder();
            const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(s));
            return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        }
    };

    // ---------- INDEXED DB ----------
    const DB = {
        db: null,
        async open() {
            if (this.db) return this.db;
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(LIB.DB_NAME, LIB.DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(LIB.DB_STORE)) {
                        db.createObjectStore(LIB.DB_STORE, { keyPath: 'id' });
                    }
                };
                req.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
                req.onerror = e => reject(e);
            });
        },
        async act(mode, fn) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(LIB.DB_STORE, mode);
                const req = fn(tx.objectStore(LIB.DB_STORE));
                req.onsuccess = () => resolve(req.result);
                req.onerror = (e) => reject(e);
            });
        },
        get(id) { return this.act('readonly', s => s.get(id)); },
        put(val) { return this.act('readwrite', s => s.put(val)); },
        getAll() { return this.act('readonly', s => s.getAll()); }
    };

    // ---------- UI (SHADOW DOM) ----------
    const UI = {
        host: null, shadow: null, root: null, overlay: null, listContainer: null, statusBar: null,
        
        init() {
            // 1. Overlay
            this.overlay = Utils.create('div', {
                id: 'la-overlay',
                style: `position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:${LIB.UI_ZINDEX - 1};overflow:hidden;`
            }, document.body);

            // 2. Host
            this.host = Utils.create('div', { id: LIB.APP_ID });
            this.shadow = this.host.attachShadow({ mode: 'open' });
            document.documentElement.appendChild(this.host);

            // Style
            Utils.create('style', {
                text: `
                :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                .panel {
                    position: fixed; bottom: 20px; right: 20px; width: 300px;
                    background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(10px);
                    border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
                    border: 1px solid rgba(0,0,0,0.1); color: #333; display: flex; flex-direction: column;
                    z-index: ${LIB.UI_ZINDEX}; font-size: 14px; transition: opacity 0.2s;
                }
                .header {
                    padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between;
                    cursor: grab; user-select: none; background: #f8f9fa; border-radius: 12px 12px 0 0;
                }
                .header:active { cursor: grabbing; }
                .title { font-weight: 700; color: #222; font-size: 14px; }
                
                .min-btn { cursor: pointer; padding: 4px 8px; font-size: 18px; opacity: 0.6; border:none; background:none; font-weight: bold; color: #555; }
                .min-btn:hover { opacity: 1; background: rgba(0,0,0,0.05); border-radius: 4px; }
                
                .body { padding: 16px; max-height: 400px; overflow-y: auto; }
                
                .actions { display: flex; gap: 8px; margin-bottom: 16px; }
                button.btn {
                    flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ddd; background: #fff;
                    cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s; display: flex; justify-content: center; gap: 6px;
                }
                button.btn:hover { background: #f5f5f5; border-color: #bbb; }
                button.btn-primary { background: #222; color: #fff; border-color: #222; }
                button.btn-primary:hover { background: #000; }
                
                .color-picker { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; justify-content: center; }
                .color-dot { width: 24px; height: 24px; border-radius: 50%; cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 0 1px #ddd; transition: transform 0.1s; }
                .color-dot:hover { transform: scale(1.1); }
                .color-dot.active { box-shadow: 0 0 0 2px #333; transform: scale(1.1); }

                .list-empty { color: #999; text-align: center; padding: 20px 0; font-style: italic; font-size: 12px; }
                .ann-item { padding: 12px; border: 1px solid #eee; border-radius: 8px; margin-bottom: 8px; background: #fff; transition: background 0.2s; }
                .ann-item:hover { background: #fafafa; border-color: #ddd; }
                
                .ann-meta { display: flex; justify-content: space-between; font-size: 10px; color: #999; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
                .ann-note { font-size: 13px; color: #333; line-height: 1.4; display: flex; gap: 8px; align-items: flex-start; }
                .pin-icon { font-style: normal; }
                
                .ann-controls { display: flex; gap: 12px; margin-top: 8px; justify-content: flex-end; opacity: 0.4; transition: opacity 0.2s; padding-top: 8px; border-top: 1px solid #f5f5f5;}
                .ann-item:hover .ann-controls { opacity: 1; }
                .icon-btn { cursor: pointer; font-size: 14px; border:none; background:none; padding: 0; color: #777; }
                .icon-btn:hover { color: #000; }
                
                .status-bar { font-size: 11px; color: #aaa; margin-top: 10px; text-align: center; border-top: 1px solid #f0f0f0; padding-top: 8px; }
                `
            }, this.shadow);

            // Panel
            this.root = Utils.create('div', { class: 'panel' }, this.shadow);
            
            // Header
            const header = Utils.create('div', { class: 'header' }, this.root);
            Utils.create('span', { text: 'Notes Épinglées', class: 'title' }, header);
            Utils.create('button', { 
                text: '–', class: 'min-btn', title: 'Réduire',
                onClick: (e) => Actions.toggleMinimize(e.target) 
            }, header);

            // DRAG & DROP LOGIC (Panel & Pins)
            // 1. Panel Dragging Start
            header.addEventListener('mousedown', (e) => {
                state.isDragging = true;
                const rect = this.root.getBoundingClientRect();
                state.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            });

            // 2. Global MouseMove (Handles both Panel and Pin dragging)
            document.addEventListener('mousemove', (e) => {
                // Panel Drag
                if (state.isDragging) {
                    e.preventDefault();
                    this.root.style.right = 'auto';
                    this.root.style.bottom = 'auto';
                    this.root.style.left = `${e.clientX - state.dragOffset.x}px`;
                    this.root.style.top = `${e.clientY - state.dragOffset.y}px`;
                }
                
                // Pin Drag
                if (state.draggingPin) {
                    e.preventDefault();
                    const dx = e.pageX - state.draggingPin.startX;
                    const dy = e.pageY - state.draggingPin.startY;
                    
                    // Seuil de mouvement pour différencier un click d'un drag
                    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                        state.draggingPin.hasMoved = true;
                    }

                    if (state.draggingPin.hasMoved) {
                        // Mise à jour visuelle immédiate (pas de save DB ici pour perf)
                        const newX = state.draggingPin.originalX + dx;
                        const newY = state.draggingPin.originalY + dy;
                        state.draggingPin.el.style.left = newX + 'px';
                        state.draggingPin.el.style.top = newY + 'px';
                        // Curseur
                        document.body.style.cursor = 'grabbing';
                        state.draggingPin.el.style.cursor = 'grabbing';
                    }
                }
            });

            // 3. Global MouseUp
            document.addEventListener('mouseup', (e) => {
                // End Panel Drag
                state.isDragging = false;

                // End Pin Drag
                if (state.draggingPin) {
                    document.body.style.cursor = 'default';
                    state.draggingPin.el.style.cursor = 'grab';

                    if (state.draggingPin.hasMoved) {
                        // Sauvegarde de la nouvelle position dans IndexedDB
                        const annId = state.draggingPin.id;
                        const ann = state.record.annotations.find(a => a.id === annId);
                        if (ann) {
                            ann.position.x = state.draggingPin.originalX + (e.pageX - state.draggingPin.startX);
                            ann.position.y = state.draggingPin.originalY + (e.pageY - state.draggingPin.startY);
                            Actions.save(); // Persist
                        }
                    } else {
                        // C'était un click simple : action "Ouvrir/Alert"
                        const annId = state.draggingPin.id;
                        const ann = state.record.annotations.find(a => a.id === annId);
                        
                        // Ouvrir le panneau si caché
                        const host = document.getElementById(LIB.APP_ID);
                        if (host && host.style.display === 'none') host.style.display = 'block';
                        if (state.isMinimized) {
                            const btn = UI.shadow.querySelector('.min-btn');
                            if(btn) Actions.toggleMinimize(btn);
                        }
                        
                        if (ann) alert(ann.note);
                    }

                    state.draggingPin = null;
                }
            });

            // Body
            const body = Utils.create('div', { class: 'body' }, this.root);

            // Color Picker
            const cpContainer = Utils.create('div', { class: 'color-picker' }, body);
            Object.entries(LIB.colors).forEach(([name, val]) => {
                const dot = Utils.create('div', { 
                    class: `color-dot ${name === state.currentColor ? 'active' : ''}`, 
                    style: `background-color: ${val}`,
                    title: name
                }, cpContainer);
                dot.addEventListener('click', () => {
                    state.currentColor = name;
                    this.shadow.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                    dot.classList.add('active');
                });
            });

            // Actions
            const actions = Utils.create('div', { class: 'actions' }, body);
            Utils.create('button', { class: 'btn btn-primary', html: '<span>📍</span> Ajouter une note', onClick: () => Actions.enterPinMode() }, actions);
            Utils.create('button', { class: 'btn', text: '💾 JSON', onClick: () => Actions.exportJSON() }, actions);

            // List
            this.listContainer = Utils.create('div', { id: 'list' }, body);
            this.statusBar = Utils.create('div', { class: 'status-bar', text: 'Prêt.' }, body);

            const ro = new ResizeObserver(() => { requestAnimationFrame(() => Actions.renderAll()); });
            ro.observe(document.body);
        },

        setStatus(msg) { if (this.statusBar) this.statusBar.textContent = msg; },

        renderList() {
            this.listContainer.innerHTML = '';
            const anns = state.record?.annotations || [];
            const pins = anns.filter(a => a.type === 'pin');

            if (pins.length === 0) {
                this.listContainer.innerHTML = '<div class="list-empty">Aucune note épinglée.</div>';
                return;
            }

            [...pins].reverse().forEach(ann => {
                const item = Utils.create('div', { class: 'ann-item' }, this.listContainer);
                
                const meta = Utils.create('div', { class: 'ann-meta' }, item);
                Utils.create('span', { text: `X: ${Math.round(ann.position.x)} Y: ${Math.round(ann.position.y)}` }, meta);
                Utils.create('span', { text: new Date(ann.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }, meta);

                const noteDiv = Utils.create('div', { class: 'ann-note' }, item);
                Utils.create('span', { text: '📍', class: 'pin-icon', style: `color: ${LIB.colors[ann.color]}` }, noteDiv);
                Utils.create('span', { text: ann.note || '(Sans texte)' }, noteDiv);

                const ctrls = Utils.create('div', { class: 'ann-controls' }, item);
                const btnGo = Utils.create('button', { class: 'icon-btn', text: 'Cibler', title: 'Aller à la note' }, ctrls);
                const btnEdit = Utils.create('button', { class: 'icon-btn', text: 'Éditer', title: 'Modifier le texte' }, ctrls);
                const btnDel = Utils.create('button', { class: 'icon-btn', text: 'Supprimer', title: 'Supprimer' }, ctrls);

                btnGo.onclick = () => Actions.scrollTo(ann);
                btnEdit.onclick = () => Actions.editNote(ann);
                btnDel.onclick = () => Actions.delete(ann.id);
            });
        }
    };

    // ---------- ACTIONS LOGIC ----------
    const Actions = {
        async init() {
            await UI.init();
            await this.loadPageRecord();
        },

        toggle() {
            const host = document.getElementById(LIB.APP_ID);
            if (host) {
                host.style.display = host.style.display === 'none' ? 'block' : 'none';
                if (host.style.display === 'block') this.loadPageRecord();
            } else {
                this.init();
            }
        },

        toggleMinimize(btn) {
            state.isMinimized = !state.isMinimized;
            const body = UI.shadow.querySelector('.body');
            if (state.isMinimized) {
                body.style.display = 'none';
                btn.textContent = '+'; btn.title = 'Agrandir';
            } else {
                body.style.display = 'block';
                btn.textContent = '–'; btn.title = 'Réduire';
            }
        },

        async loadPageRecord() {
            const pageUrl = location.href;
            const origin = location.origin;
            const id = origin + '|' + pageUrl;
            
            UI.setStatus('Chargement...');
            const html = document.body.innerHTML;
            const pageHash = await Utils.hashString(html);

            let record = await DB.get(id);
            if (!record) {
                record = { id, origin, pageUrl, pageHash, annotations: [], createdAt: Utils.nowIso() };
                await DB.put(record);
            }
            state.record = record;
            UI.renderList();
            this.renderAll();
            UI.setStatus('Prêt.');
        },

        async save() {
            state.record.updatedAt = Utils.nowIso();
            await DB.put(state.record);
            UI.renderList();
            this.renderAll();
        },

        enterPinMode() {
            UI.host.style.display = 'none';
            document.body.style.cursor = 'crosshair';
            
            const handler = (e) => {
                e.preventDefault(); e.stopPropagation();
                const x = e.pageX;
                const y = e.pageY;
                
                UI.host.style.display = 'block'; 
                document.body.style.cursor = 'default';
                
                setTimeout(() => {
                    const note = prompt("Note à épingler :");
                    if (note) {
                        state.record.annotations.push({
                            id: Utils.generateId(),
                            type: 'pin',
                            position: { x, y },
                            color: state.currentColor,
                            createdAt: Utils.nowIso(),
                            note
                        });
                        this.save();
                    }
                }, 50);
            };

            document.addEventListener('click', handler, { capture: true, once: true });
            document.addEventListener('keydown', function k(e) {
                if(e.key === 'Escape') {
                    document.body.style.cursor = 'default';
                    document.removeEventListener('click', handler, true);
                    UI.host.style.display = 'block';
                    document.removeEventListener('keydown', k);
                }
            }, { once: true });
        },

        async editNote(ann) {
            const newNote = prompt("Modifier la note :", ann.note || "");
            if (newNote !== null) { ann.note = newNote; this.save(); }
        },

        async delete(id) {
            if(!confirm('Supprimer cette note ?')) return;
            state.record.annotations = state.record.annotations.filter(a => a.id !== id);
            this.save();
        },

        scrollTo(ann) {
            window.scrollTo({
                top: ann.position.y - (window.innerHeight / 2),
                left: ann.position.x - (window.innerWidth / 2),
                behavior: 'smooth'
            });
            setTimeout(() => {
                const el = document.getElementById('pin_' + ann.id);
                if(el) {
                    el.style.transition = 'transform 0.2s';
                    el.style.transform = 'translate(-50%, -100%) scale(1.5)';
                    setTimeout(() => el.style.transform = 'translate(-50%, -100%) scale(1)', 400);
                }
            }, 300);
        },

        exportJSON() {
            const blob = new Blob([JSON.stringify(state.record, null, 2)], {type: 'application/json'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'notes-positions.json';
            a.click();
        },

        renderAll() {
            UI.overlay.innerHTML = ''; 
            if (!state.record) return;
            state.record.annotations.forEach(ann => {
                if (ann.type === 'pin') this.drawPin(ann);
            });
        },

        drawPin(ann) {
            const { x, y } = ann.position;
            const color = LIB.colors[ann.color] || LIB.colors.yellow;
            
            const pinGroup = Utils.create('div', {
                id: 'pin_' + ann.id,
                style: `
                    position: absolute; 
                    left: ${x}px; 
                    top: ${y}px; 
                    transform: translate(-50%, -100%); 
                    cursor: grab; 
                    pointer-events: auto; 
                    z-index: ${LIB.UI_ZINDEX + 10};
                    display: flex; flex-direction: column; align-items: center;
                `
            }, UI.overlay);
            
            // Écouteur pour démarrer le Drag
            pinGroup.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Stop text selection
                e.stopPropagation();
                
                // Initialisation du drag
                state.draggingPin = {
                    id: ann.id,
                    el: pinGroup,
                    startX: e.pageX,
                    startY: e.pageY,
                    originalX: ann.position.x,
                    originalY: ann.position.y,
                    hasMoved: false
                };
            });

            const pinIcon = Utils.create('div', {
                html: `<svg width="32" height="32" viewBox="0 0 24 24" fill="${color}" stroke="#333" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="rgba(255,255,255,0.4)"></circle></svg>`,
                style: `filter: drop-shadow(0 4px 4px rgba(0,0,0,0.3)); transition: transform 0.2s;`
            }, pinGroup);

            const bubble = Utils.create('div', {
                text: ann.note,
                style: `
                    position: absolute; 
                    bottom: 34px; 
                    background: #222; color: #fff; 
                    padding: 4px 8px; border-radius: 4px; 
                    font-size: 12px; white-space: nowrap; 
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    opacity: 0; pointer-events: none; transition: opacity 0.2s;
                    max-width: 200px; overflow: hidden; text-overflow: ellipsis;
                `
            }, pinGroup);

            pinGroup.onmouseenter = () => {
                if(!state.draggingPin) {
                    pinIcon.style.transform = 'scale(1.1) translateY(-2px)';
                    bubble.style.opacity = '1';
                }
            };
            pinGroup.onmouseleave = () => {
                if(!state.draggingPin) {
                    pinIcon.style.transform = 'scale(1) translateY(0)';
                    bubble.style.opacity = '0';
                }
            };
        }
    };

    window.__LightAnnotatorActive = Actions;
    Actions.init();

})();