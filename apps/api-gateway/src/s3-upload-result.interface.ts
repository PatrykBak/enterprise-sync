export interface S3UploadResult {
  status: 'accepted' | 'rejected' | 'processing';
  fileId: string;
  sha256: string;
  message: string;
  objectKey: string;
}
