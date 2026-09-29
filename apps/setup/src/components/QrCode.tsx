import { useMemo } from "preact/hooks";
import { qrPath } from "../qr";

/** Renders `payload` as a crisp, theme-independent SVG QR code (always dark on white). */
export function QrCode(props: { payload: string; label: string; size?: number }) {
  const qr = useMemo(() => qrPath(props.payload), [props.payload]);
  return (
    <svg
      class="qr"
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={props.size ?? 264}
      height={props.size ?? 264}
      shape-rendering="crispEdges"
      data-modules={qr.size}
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.path} fill="#0d1411" />
    </svg>
  );
}
