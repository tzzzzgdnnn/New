// Long-press: the touch stand-in for right-click. Returns touch handlers that
// call `open` with a contextmenu-like event after a still 500 ms hold, and
// swallow the tap that the lift would otherwise fire.
const HOLD_MS = 500;
const SLOP_PX = 10;

let press = null; // { timer, x, y } for the finger currently down
let swallowTap = false;
let installed = false;

function install() {
  installed = true;
  window.addEventListener(
    "click",
    (e) => {
      if (!swallowTap) return;
      swallowTap = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

function cancel() {
  if (press) clearTimeout(press.timer);
  press = null;
}

export function longPressProps(open) {
  return {
    onTouchStart(e) {
      cancel();
      swallowTap = false;
      if (e.touches.length !== 1) return;
      if (!installed) install();
      const { clientX, clientY } = e.touches[0];
      const target = e.currentTarget;
      press = {
        x: clientX,
        y: clientY,
        timer: setTimeout(() => {
          press = null;
          swallowTap = true;
          open({ clientX, clientY, currentTarget: target, preventDefault() {}, stopPropagation() {} });
        }, HOLD_MS),
      };
    },
    onTouchMove(e) {
      if (!press) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - press.x) > SLOP_PX || Math.abs(t.clientY - press.y) > SLOP_PX) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}
