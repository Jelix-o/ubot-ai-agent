/** Reads dimensions from supported raster headers without decoding or retaining image pixels. */
export function imageDimensions(data: Buffer): string | undefined {
  let width = 0, height = 0;
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString("ascii", 12, 16) === "IHDR") {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length >= 25 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X" && data.length >= 30) {
      width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3);
    } else if (chunk === "VP8 " && data.length >= 30 && data.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && data[20] === 47) {
      width = 1 + data[21]! + ((data[22]! & 63) << 8);
      height = 1 + (data[22]! >> 6) + (data[23]! << 2) + ((data[24]! & 15) << 10);
    }
  } else if (data[0] === 255 && data[1] === 216) {
    for (let offset = 2; offset + 3 < data.length;) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218 || offset + 2 > data.length) break;
      if (marker === 1 || (marker! >= 208 && marker! <= 215)) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker!) && length >= 7) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  return width > 0 && height > 0 && width <= 65535 && height <= 65535 ? `${width}x${height}` : undefined;
}
