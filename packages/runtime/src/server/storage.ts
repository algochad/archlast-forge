import { S3Client } from "bun";

export interface Storage {
  putPresignedUrl(key: string, opts?: { contentType?: string; expiresIn?: number }): string;
  getPresignedUrl(key: string, opts?: { expiresIn?: number }): string;
  delete(key: string): Promise<void>;
}

/** S3-compatible storage (AWS, RustFS, MinIO). Presigning is local, so it's safe inside queries. */
export class S3Storage implements Storage {
  private s3: S3Client;

  constructor(opts: { endpoint: string; bucket: string; accessKeyId?: string; secretAccessKey?: string; region?: string }) {
    this.s3 = new S3Client(opts);
  }

  putPresignedUrl(key: string, { contentType, expiresIn = 3600 }: { contentType?: string; expiresIn?: number } = {}) {
    return this.s3.presign(key, { method: "PUT", expiresIn, type: contentType });
  }

  getPresignedUrl(key: string, { expiresIn = 3600 } = {}) {
    return this.s3.presign(key, { method: "GET", expiresIn });
  }

  async delete(key: string) {
    await this.s3.delete(key);
  }
}
