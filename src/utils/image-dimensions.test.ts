import assert from "node:assert/strict";
import test from "node:test";
import { imageDimensions } from "./image-dimensions.js";

test("actual raster dimensions are read from PNG, JPEG and WebP bytes", () => {
  assert.equal(imageDimensions(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABEAAAAdCAIAAADDzRDWAAAAKklEQVR4nGOsWHWCgUTARKqGUT1gwMRAOmAa1cMwGgYMo2HAMBoG5IYBAPOhAiRb9j43AAAAAElFTkSuQmCC", "base64")), "17x29");
  assert.equal(imageDimensions(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAdABEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDeooor1DxwooooAKKKKACiiigD/9k=", "base64")), "17x29");
  assert.equal(imageDimensions(Buffer.from("UklGRkQAAABXRUJQVlA4IDgAAAAwAwCdASoRAB0APm0ylkekIyIhKAgAgA2JZQDJAoAAQFBQAP7rB//bZg+g/d/rUyMfVTHJvQAAAA==", "base64")), "17x29");
  assert.equal(imageDimensions(Buffer.from("invalid")), undefined);
});
