import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RekognitionClient } from '@aws-sdk/client-rekognition';

export const prisma = new PrismaClient();
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
export const s3 = new S3Client({
  endpoint: `${process.env.MINIO_ENDPOINT || 'http://localhost'}:${process.env.MINIO_PORT || '9000'}`,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'nexa',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'change-me-now'
  }
});
export const moderationS3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
export const rekognition = new RekognitionClient({ region: process.env.AWS_REGION || 'us-east-1' });

export { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand };

export async function connectServices() {
  await prisma.$connect();
  await redis.connect();
  const bucket = process.env.MINIO_BUCKET || 'nexa-media';
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  return { bucket };
}

export async function disconnectServices() {
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
}
