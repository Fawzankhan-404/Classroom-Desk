import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export type PrivateSaaSProfile = { googleSubject: string; email: string; displayName: string };

/** Version 1 profile envelope used by the already-applied D1 migration 0007. */
export class SaaSProfileCipher {
  private readonly key: Buffer;
  private readonly lookupKey: Buffer;

  constructor(keyBase64: string | undefined) {
    if (!keyBase64 || !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) throw new Error("invalid_profile_encryption_key");
    const master = Buffer.from(keyBase64, "base64");
    if (master.length !== 32 || master.toString("base64") !== keyBase64) throw new Error("invalid_profile_encryption_key");
    this.key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "classroom-saas-profile-v1", 32));
    this.lookupKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "classroom-saas-profile-lookups-v1", 32));
    master.fill(0);
  }

  digest(value: string): string { return createHmac("sha256", this.lookupKey).update(value).digest("hex"); }

  seal(profile: PrivateSaaSProfile): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(profile), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
  }

  open(value: string): PrivateSaaSProfile {
    try {
      const [version, ivText, tagText, bodyText] = value.split(".");
      if (version !== "v1" || !ivText || !tagText || !bodyText) throw new Error("invalid_profile_envelope");
      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid_profile_envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const profile = JSON.parse(Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8")) as PrivateSaaSProfile;
      if (!profile || typeof profile.googleSubject !== "string" || typeof profile.email !== "string" || typeof profile.displayName !== "string") throw new Error("invalid_profile");
      return profile;
    } catch { throw new Error("stored_profile_unavailable"); }
  }
}
