import { deviceColorFor } from './deviceColors';
import { backgroundColorRef } from './sizing';

/**
 * A device's colour dot, the same everywhere the device appears. With a name it reads "● Seagate"; without one it is only the dot
 * (then give `label` so a screen reader still says which device). The colour is the device's own, else one picked from its name.
 */
export function DeviceDot({ name, color, label }: { name: string; color?: string | null; label?: string }) {
  const dot = <span className="device-dot" ref={backgroundColorRef(color ?? deviceColorFor(name))} aria-hidden="true" />;
  if (label !== undefined) {
    return (
      <span className="device-dot-label">
        {dot}
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="device-dot-label">
      {dot}
      <span>{name}</span>
    </span>
  );
}
