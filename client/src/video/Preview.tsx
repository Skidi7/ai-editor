import { useEffect, useRef, useState } from 'react';
import { IconBreak, IconPause, IconPlay } from '../editor/Icons';
import type { FrameLayout } from './compositor';
import { Player, setCurrentPlayer } from './player';
import { insertColor } from './script';
import { useVideo } from './store';
import { clipAt, formatTime } from './timeline';
import { ASPECT_SIZE } from './types';

type Drag =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | { kind: 'resize'; id: string; left: number }
  | { kind: 'caption' }
  | null;

/**
 * Live composition preview: the same drawFrame as the export, drawn into a phone-shaped canvas.
 * When paused, inserts can be dragged / resized and the caption block dragged vertically right on the canvas.
 */
export function Preview() {
  const project = useVideo((s) => s.project);
  const tl = useVideo((s) => s.tl);
  const selection = useVideo((s) => s.selection);
  const select = useVideo((s) => s.select);
  const updateInsert = useVideo((s) => s.updateInsert);
  const updateStyle = useVideo((s) => s.updateStyle);
  const setPlayhead = useVideo((s) => s.setPlayhead);
  const setPlaying = useVideo((s) => s.setPlaying);
  const updateScene = useVideo((s) => s.updateScene);
  const playing = useVideo((s) => s.playing);
  const playhead = useVideo((s) => s.playhead);
  const splitAtPlayhead = useVideo((s) => s.splitAtPlayhead);
  const exportState = useVideo((s) => s.exportState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const layoutRef = useRef<FrameLayout>({ inserts: [], caption: null });
  const dragRef = useRef<Drag>(null);
  const [time, setTime] = useState(0);
  const [cursor, setCursor] = useState('pointer');
  const size = ASPECT_SIZE[project.aspect];
  const selectedInsertId = selection.type === 'insert' ? selection.id : null;

  useEffect(() => {
    const player = new Player(useVideo.getState().project, useVideo.getState().tl);
    playerRef.current = player;
    setCurrentPlayer(player);
    player.onDuration = (sceneId, duration) => {
      const s = useVideo.getState().project.scenes.find((x) => x.id === sceneId);
      if (s?.take && Math.abs(s.take.duration - duration) > 0.05) updateScene(sceneId, { take: { ...s.take, duration } });
    };
    const unsub = player.subscribe(() => {
      setTime(player.time);
      setPlayhead(player.time);
      setPlaying(player.playing);
    });
    let raf = 0;
    const thumbCanvas = document.createElement('canvas');
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const sel = useVideo.getState().selection;
      layoutRef.current = player.draw(ctx, c.width, c.height, {
        selectedInsertId: !player.playing && sel.type === 'insert' ? sel.id : null,
        showGuides: !player.playing && !!dragRef.current && dragRef.current.kind === 'caption',
        previewLabels: true,
      });
      // Scenes without a thumbnail get one from the frame the preview is showing right now
      // (the most reliable decoder is the browser's own playback pipeline).
      const clip = clipAt(player.tl, player.time);
      if (clip && clip.video && !clip.scene.thumb) {
        const v = player.video(clip.scene.id);
        if (v && v.readyState >= 2 && !v.seeking && v.videoWidth) {
          const k = Math.min(1, 180 / v.videoWidth);
          thumbCanvas.width = Math.max(1, Math.round(v.videoWidth * k));
          thumbCanvas.height = Math.max(1, Math.round(v.videoHeight * k));
          const tctx = thumbCanvas.getContext('2d');
          if (tctx) {
            try {
              tctx.drawImage(v, 0, 0, thumbCanvas.width, thumbCanvas.height);
              updateScene(clip.scene.id, { thumb: thumbCanvas.toDataURL('image/jpeg', 0.7) });
            } catch {
              /* tainted or not decodable yet */
            }
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      player.dispose();
      setCurrentPlayer(null);
      playerRef.current = null;
    };
  }, [setPlayhead, setPlaying, updateScene]);

  useEffect(() => {
    playerRef.current?.setProject(project, tl);
  }, [project, tl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        playerRef.current?.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const busy = exportState.status === 'rendering' || exportState.status === 'transcoding';
  const seek = (t: number) => playerRef.current?.seek(t);

  // ---- Direct manipulation ----
  const toCanvas = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const hitInsert = (x: number, y: number) => {
    const list = layoutRef.current.inserts;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i].box;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return list[i];
    }
    return null;
  };
  const hitHandle = (x: number, y: number) => {
    if (!selectedInsertId) return null;
    const it = layoutRef.current.inserts.find((i) => i.id === selectedInsertId);
    if (!it) return null;
    const hs = (canvasRef.current!.width / 720) * 14;
    const hx = it.box.x + it.box.w;
    const hy = it.box.y + it.box.h;
    return Math.abs(x - hx) <= hs && Math.abs(y - hy) <= hs ? it : null;
  };
  const hitCaption = (x: number, y: number) => {
    const b = layoutRef.current.caption;
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    const player = playerRef.current;
    if (!player) return;
    if (player.playing) {
      player.pause();
      return;
    }
    const { x, y } = toCanvas(e);
    const c = canvasRef.current!;
    const handle = hitHandle(x, y);
    if (handle) {
      dragRef.current = { kind: 'resize', id: handle.id, left: handle.box.x };
    } else {
      const hit = hitInsert(x, y);
      if (hit) {
        select({ type: 'insert', id: hit.id });
        dragRef.current = { kind: 'move', id: hit.id, dx: x - (hit.box.x + hit.box.w / 2), dy: y - (hit.box.y + hit.box.h / 2) };
      } else if (project.style.captions.enabled && hitCaption(x, y)) {
        dragRef.current = { kind: 'caption' };
      } else {
        player.toggle();
        return;
      }
    }
    c.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const c = canvasRef.current;
    if (!c) return;
    const { x, y } = toCanvas(e);
    const d = dragRef.current;
    if (!d) {
      if (!playing) setCursor(hitHandle(x, y) ? 'nwse-resize' : hitInsert(x, y) ? 'grab' : hitCaption(x, y) ? 'ns-resize' : 'pointer');
      return;
    }
    if (d.kind === 'move') {
      updateInsert(d.id, { x: Math.min(1.1, Math.max(-0.1, (x - d.dx) / c.width)), y: Math.min(1.1, Math.max(-0.1, (y - d.dy) / c.height)) });
    } else if (d.kind === 'resize') {
      const width = Math.min(100, Math.max(15, ((x - d.left) / c.width) * 100));
      const ins = project.inserts.find((i) => i.id === d.id);
      if (ins) {
        // Keep the left/top edge in place while resizing: the centre moves by half the width change.
        const it = layoutRef.current.inserts.find((i) => i.id === d.id);
        const cx = it ? (it.box.x + (c.width * width) / 100 / 2) / c.width : ins.x;
        updateInsert(d.id, { width: Math.round(width), x: cx, y: ins.y ?? (it ? (it.box.y + it.box.h / 2) / c.height : undefined) });
      }
    } else if (d.kind === 'caption') {
      updateStyle((s) => ({ ...s, captions: { ...s.captions, y: Math.min(0.92, Math.max(0.08, y / c.height)) } }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) canvasRef.current?.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  return (
    <div className="vs-center">
      <div className={`vs-phone ${project.aspect === '9:16' ? 'portrait' : project.aspect === '1:1' ? 'square' : 'wide'}`}>
        <canvas
          ref={canvasRef}
          width={size.w}
          height={size.h}
          style={{ cursor: playing ? 'pointer' : cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {busy && <div className="vs-phone-shield">Идёт экспорт: превью занято</div>}
        {!busy && !playing && !tl.total && <div className="vs-phone-hint">Загрузите видео (шаг 1), и оно появится здесь</div>}
      </div>
      <div className="vs-controls">
        <button type="button" className="btn icon" disabled={busy || !tl.total} onClick={() => playerRef.current?.toggle()} title="Пробел">
          {playing ? <IconPause width={18} height={18} /> : <IconPlay width={18} height={18} />}
        </button>
        <span className="vs-time">
          {formatTime(time)} / {formatTime(tl.total)}
        </span>
        <input type="range" className="vs-scrub" min={0} max={Math.max(0.1, tl.total)} step={0.02} value={Math.min(playhead, tl.total)} disabled={busy} onChange={(e) => seek(Number(e.target.value))} />
        <button
          type="button"
          className="ghost small"
          disabled={busy || !tl.total}
          onClick={() => {
            playerRef.current?.pause();
            void splitAtPlayhead();
          }}
          title="Разрезать сцену под курсором в этом месте (двойной клик по дорожке делает то же)"
        >
          <IconBreak width={15} height={15} /> Разрезать на {formatTime(time)}
        </button>
      </div>
      <Timeline onSeek={seek} time={time} />
    </div>
  );
}

function Timeline({ onSeek, time }: { onSeek: (t: number) => void; time: number }) {
  const tl = useVideo((s) => s.tl);
  const project = useVideo((s) => s.project);
  const select = useVideo((s) => s.select);
  const setOpenScene = useVideo((s) => s.setOpenScene);
  const moveBoundary = useVideo((s) => s.moveBoundary);
  const mergeWithNext = useVideo((s) => s.mergeWithNext);
  const splitSceneAt = useVideo((s) => s.splitSceneAt);
  const selection = useVideo((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [dragT, setDragT] = useState<{ sceneId: string; t: number; startX: number; moved: boolean } | null>(null);
  if (!tl.total) return null;
  const pct = (t: number) => `${(t / tl.total) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.min(tl.total, Math.max(0, ((clientX - r.left) / r.width) * tl.total));
  };
  const clickSeek = (e: React.MouseEvent) => onSeek(timeAt(e.clientX));
  // Boundaries between two original, contiguous pieces of the source can be dragged (own row under the clips).
  const handles = tl.clips.slice(0, -1).flatMap((c, i) => {
    const n = tl.clips[i + 1];
    const a = c.scene;
    const b = n.scene;
    if (a.mode !== 'keep' || b.mode !== 'keep' || !a.source || !b.source || Math.abs(a.source.end - b.source.start) > 0.05) return [];
    return [{ sceneId: a.id, t: c.end, min: c.start + 0.5, max: n.end - 0.5 }];
  });
  const DRAG_THRESHOLD = 4;
  const dblSplit = (e: React.MouseEvent) => {
    const t = timeAt(e.clientX);
    const clip = tl.clips.find((c) => t >= c.start && t < c.end);
    if (clip) void splitSceneAt(clip.scene.id, t - clip.start);
  };
  return (
    <div className="vs-timeline" ref={ref} onClick={clickSeek} onDoubleClick={dblSplit} title="Клик: перейти. Двойной клик: разрезать сцену здесь">
      {handles.map((h) => {
        const active = dragT?.sceneId === h.sceneId;
        const t = active ? dragT!.t : h.t;
        return (
          <div
            key={h.sceneId}
            className={`vs-tl-handle ${active && dragT!.moved ? 'on' : ''}`}
            style={{ left: pct(t) }}
            title="Потяните, чтобы сдвинуть границу сцен. Клик: перейти к границе"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDragT({ sceneId: h.sceneId, t: h.t, startX: e.clientX, moved: false });
            }}
            onPointerMove={(e) => {
              if (!active) return;
              const moved = dragT!.moved || Math.abs(e.clientX - dragT!.startX) > DRAG_THRESHOLD;
              if (!moved) return;
              const nt = Math.min(h.max, Math.max(h.min, timeAt(e.clientX)));
              setDragT({ ...dragT!, t: nt, moved: true });
              onSeek(nt);
            }}
            onPointerUp={(e) => {
              if (!active) return;
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              if (dragT!.moved) moveBoundary(h.sceneId, dragT!.t);
              else onSeek(h.t);
              setDragT(null);
            }}
            onPointerCancel={() => setDragT(null)}
          >
            {active && dragT!.moved && <span className="vs-tl-handle-time">{formatTime(t)}</span>}
            <button
              type="button"
              className="vs-tl-merge"
              title="Склеить эти две сцены"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                mergeWithNext(h.sceneId);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {tl.clips.map((c) => {
        const sel = selection.type === 'scene' && selection.id === c.scene.id;
        const keep = c.scene.mode === 'keep';
        return (
          <div
            key={c.scene.id}
            className={`vs-tl-clip ${sel ? 'on' : ''} ${keep ? 'keep' : 'replace'} ${c.video ? 'has-video' : ''}`}
            style={{ left: pct(c.start), width: pct(c.duration) }}
            title={`${c.scene.name} · ${c.duration.toFixed(1)} с · ${keep ? 'оригинал' : c.video ? 'новый дубль' : 'дубль не сгенерирован'}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(c.start);
              select({ type: 'scene', id: c.scene.id });
              setOpenScene(c.scene.id);
            }}
          >
            {c.still && <img src={c.still} alt="" />}
            <span className="vs-tl-name">
              {c.index + 1}. {c.scene.name}
            </span>
            <span className="vs-tl-flag">{keep ? 'ориг.' : c.video ? 'новый' : 'нет дубля'}</span>
          </div>
        );
      })}
      <div className="vs-tl-lane">
        {tl.inserts.map((it) => (
          <button
            key={it.insert.id}
            type="button"
            className={`vs-tl-ins ${selection.type === 'insert' && selection.id === it.insert.id ? 'on' : ''}`}
            style={{ left: pct(it.start), width: pct(it.end - it.start), background: insertColor(project.inserts.indexOf(it.insert)) }}
            title={it.insert.name}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(it.start + 0.25);
              select({ type: 'insert', id: it.insert.id });
            }}
          >
            {it.insert.image && <img src={it.insert.image} alt="" />}
            <span>{it.insert.name}</span>
          </button>
        ))}
      </div>
      <div className="vs-tl-head" style={{ left: pct(time) }} />
    </div>
  );
}
