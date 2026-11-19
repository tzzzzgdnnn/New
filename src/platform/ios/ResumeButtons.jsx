// iOS play buttons for a title page: one primary action ("Resume S1:E3 ·
// 12:34", "Play S1:E4", "Play") and "Restart" as a secondary option when
// there is a saved spot.
import { PlayIcon } from "../../components/Icons";

export default function ResumeButtons({ label, onPrimary, onRestart }) {
  return (
    <>
      <button className="btn btn-primary sb-resume-btn" onClick={onPrimary}>
        <PlayIcon /> {label}
      </button>
      {onRestart && (
        <button className="btn btn-secondary" onClick={onRestart}>
          ↺ Restart
        </button>
      )}
    </>
  );
}

/** Ask the inline player to reopen the native player (page already playing). */
export const replayNative = () => window.dispatchEvent(new CustomEvent("sb-replay"));
