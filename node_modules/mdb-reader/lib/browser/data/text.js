import { uncompressText } from "../unicodeCompression.js";
export function readText(buffer, _col, db) {
    return uncompressText(buffer, db.format);
}
