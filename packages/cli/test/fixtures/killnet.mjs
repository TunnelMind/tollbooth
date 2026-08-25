// Air-gap preload for the AC-6.1 test: any network attempt in this process
// throws. fetch covers undici; the Socket.connect patch covers http/https/net.
import net from "node:net";

globalThis.fetch = () => {
  throw new Error("network disabled (AC-6.1)");
};
net.Socket.prototype.connect = () => {
  throw new Error("network disabled (AC-6.1)");
};
