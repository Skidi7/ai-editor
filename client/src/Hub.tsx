import { useEffect } from 'react';
import { IconFaceSwap, IconFilm, IconImage, IconWave } from './editor/Icons';
import './video/video.css';

/** Demo stand landing: one card per tool. */
export default function Hub() {
  useEffect(() => {
    document.title = 'AI Tools';
  }, []);
  return (
    <div className="hub">
      <header className="hub-head">
        <span className="brand-mark" />
        <div>
          <h1>AI Tools · демостенд</h1>
          <p className="muted">Инструменты для генерации и правки контента. Выберите инструмент.</p>
        </div>
      </header>
      <div className="hub-grid">
        <a className="hub-card" href="/image">
          <span className="hub-icon">
            <IconImage width={26} height={26} />
          </span>
          <b>Image Studio</b>
          <span className="muted">Редактор изображений: правка выделения, Expand & Crop, фон, свет, Color Lab — Seedream 5.0 Pro.</span>
        </a>
        <a className="hub-card" href="/video">
          <span className="hub-icon">
            <IconFilm width={26} height={26} />
          </span>
          <b>Video Studio</b>
          <span className="muted">Видео с AI-ведущим по сценарию: фото → образы (Seedream 5 Pro) → дубли (Seedance 2.5) → вставки, субтитры, доска, экспорт.</span>
        </a>
        <a className="hub-card" href="/voice">
          <span className="hub-icon">
            <IconWave width={26} height={26} />
          </span>
          <b>Voice Studio</b>
          <span className="muted">Озвучка текста голосами из библиотеки, создание голоса по описанию, захват голоса из видео и клон своего голоса — OmniVoice и Qwen3 TTS.</span>
        </a>
        <a className="hub-card" href="/faceswap">
          <span className="hub-icon">
            <IconFaceSwap width={26} height={26} />
          </span>
          <b>Face Swap</b>
          <span className="muted">Замена головы или всего человека на фото: LoRA BFS «Best Face Swap» на Qwen-Image 2.1 — голова с волосами или человек целиком с одного фото в сцену другого.</span>
        </a>
      </div>
    </div>
  );
}
