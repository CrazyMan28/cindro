import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { VoiceProfileService } from "../audio/voiceProfiles.js";
import {
  isCloneVoiceId,
  listCloneVoices,
  readCloneRefAudioBase64,
  cloneClipPath
} from "../voices/cloneVoices.js";

function seededDb() {
  const db = new AppDatabase("file::memory:");
  new ExtensionService(db).seedDefaults();
  return db;
}

describe("named cloned voices (the user's recorded/uploaded voice library)", () => {
  let home: string;
  let prevHome: string | undefined;
  let voicesDir: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voices-"));
    process.env.HOME = home;
    voicesDir = path.join(home, ".config", "jarvis", "voices");
    fs.mkdirSync(voicesDir, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("isCloneVoiceId matches jarvice + clone:<slug>, rejects others", () => {
    expect(isCloneVoiceId("jarvice")).toBe(true);
    expect(isCloneVoiceId("clone:dads_voice")).toBe(true);
    expect(isCloneVoiceId("local:jarvis")).toBe(false);
    expect(isCloneVoiceId("11111111-2222-3333-8444-555555555555")).toBe(false);
    expect(isCloneVoiceId(undefined)).toBe(false);
  });

  it("lists clones from the manifest + scans loose clips, and reads ref audio", () => {
    fs.writeFileSync(path.join(voicesDir, "jarvice_ref.mp3"), Buffer.from("fake-jarvice"));
    fs.writeFileSync(path.join(voicesDir, "dads_voice_ref.wav"), Buffer.from("fake-dad"));
    // A loose clip with no manifest row still shows up (e.g. jarvice_voice.py drop-in).
    fs.writeFileSync(path.join(voicesDir, "moms_voice_ref.mp3"), Buffer.from("fake-mom"));
    fs.writeFileSync(
      path.join(voicesDir, "voices.json"),
      JSON.stringify({
        default: "clone:dads_voice",
        voices: [
          { id: "jarvice", slug: "jarvice", name: "Jarvis" },
          { id: "dads_voice", slug: "dads_voice", name: "Dad's Voice" }
        ]
      })
    );

    const voices = listCloneVoices();
    const byId = new Map(voices.map((v) => [v.id, v.name]));
    expect(byId.get("jarvice")).toBe("Jarvis");
    expect(byId.get("clone:dads_voice")).toBe("Dad's Voice");
    expect(byId.get("clone:moms_voice")).toBe("moms_voice"); // scanned, no manifest name

    // ref audio is the clip's bytes, base64-encoded
    expect(readCloneRefAudioBase64("clone:dads_voice")).toBe(
      Buffer.from("fake-dad").toString("base64")
    );
    expect(readCloneRefAudioBase64("jarvice")).toBe(
      Buffer.from("fake-jarvice").toString("base64")
    );
    expect(cloneClipPath("clone:dads_voice")).toBe(path.join(voicesDir, "dads_voice_ref.wav"));
    // a deleted/unknown clone => undefined (caller falls back, TTS never breaks)
    expect(readCloneRefAudioBase64("clone:ghost")).toBeUndefined();
  });

  it("returns [] cleanly when the voices dir does not exist", () => {
    fs.rmSync(voicesDir, { recursive: true, force: true });
    expect(listCloneVoices()).toEqual([]);
    expect(readCloneRefAudioBase64("clone:dads_voice")).toBeUndefined();
  });

  it("a voice profile ACCEPTS a clone:<slug> / jarvice voiceId (not just UUIDs)", () => {
    const db = seededDb();
    const svc = new VoiceProfileService(db);
    expect(svc.set("101", { voiceId: "clone:dads_voice" })?.voiceId).toBe("clone:dads_voice");
    expect(svc.set("101", { voiceId: "jarvice" })?.voiceId).toBe("jarvice");
    // a bare display name is still rejected (would brick later calls)
    expect(() => svc.set("101", { voiceId: "Oliver" })).toThrow(/UUID/);
    db.close();
  });
});
