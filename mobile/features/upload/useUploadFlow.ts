import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadBatchSize } from "@/constants/config";
import { assetsService, type ImportableAssetType } from "@/services/assets";
import { describeError } from "@/services/errors";
import { gcpService } from "@/services/gcp";
import { processingService } from "@/services/processing";
import { surveysService, type LocalFile } from "@/services/surveys";
import type { SurveyImage } from "@/types";
import { queryKeys } from "../queryKeys";

export type UploadState = "IDLE" | "SELECTING" | "UPLOADING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface UploadProgress {
  state: UploadState;
  /** 0..1 across all batches. */
  fraction: number;
  uploadedFiles: number;
  totalFiles: number;
  currentBatch: number;
  totalBatches: number;
  error: string | null;
  /** The GCP file could not be attached (the photos were uploaded and processing started anyway). */
  gcpError: string | null;
}

/** The optional surveyed positions of the ground targets, sent with the photos. */
export interface GcpUpload {
  file: LocalFile;
  rtk: boolean;
  epsg: string;
}

const initial: UploadProgress = { state: "IDLE", fraction: 0, uploadedFiles: 0, totalFiles: 0, currentBatch: 0, totalBatches: 0, error: null, gcpError: null };

/** Shown when every uploaded photo lacks a GPS position (same wording as the website). */
export const NO_GPS_MESSAGE =
  "These photos have no GPS position, so they cannot be placed on a map. Use the original files from the drone's memory card — copies from a phone gallery or a messaging app often lose it.";

/**
 * Drives the mobile upload flow: images in small batches → (optionally) start
 * the backend pipeline. The phone never processes anything; it just moves
 * bytes to the FastAPI server, which does the work.
 */
export function useUploadFlow(surveyId: string | null) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<UploadProgress>(initial);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(initial);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const uploadImages = useCallback(
    async (files: LocalFile[], startProcessing: boolean, gcp?: GcpUpload | null) => {
      if (!surveyId || files.length === 0) return false;
      const controller = new AbortController();
      abortRef.current = controller;
      const totalBatches = Math.ceil(files.length / uploadBatchSize);
      setProgress({ state: "UPLOADING", fraction: 0, uploadedFiles: 0, totalFiles: files.length, currentBatch: 1, totalBatches, error: null, gcpError: null });

      try {
        const received: SurveyImage[] = [];
        for (let b = 0; b < totalBatches; b++) {
          const batch = files.slice(b * uploadBatchSize, (b + 1) * uploadBatchSize);
          const saved = await surveysService.uploadImages(surveyId, batch, {
            signal: controller.signal,
            onProgress: (f) =>
              setProgress((p) => ({
                ...p,
                currentBatch: b + 1,
                fraction: (b + f) / totalBatches,
                uploadedFiles: b * uploadBatchSize + Math.floor(f * batch.length),
              })),
          });
          received.push(...(saved ?? []));
          setProgress((p) => ({ ...p, uploadedFiles: Math.min((b + 1) * uploadBatchSize, files.length), fraction: (b + 1) / totalBatches }));
        }
        qc.invalidateQueries({ queryKey: queryKeys.surveyImages(surveyId) });
        qc.invalidateQueries({ queryKey: queryKeys.survey(surveyId) });
        qc.invalidateQueries({ queryKey: queryKeys.surveys });

        if (received.length > 0 && received.every((img) => img.lat == null)) {
          setProgress((p) => ({ ...p, state: "FAILED", error: NO_GPS_MESSAGE }));
          return false;
        }
        // attached before processing starts, so the detailed map is lined up
        // with it; if it cannot be, the photos still go ahead and the flight
        // screen offers to add the points again
        if (gcp) {
          try {
            await gcpService.uploadFile(surveyId, gcp.file, { rtk: gcp.rtk, epsg: gcp.epsg });
            qc.invalidateQueries({ queryKey: queryKeys.gcpCheck(surveyId) });
          } catch (err) {
            const message = describeError(err).message;
            setProgress((p) => ({ ...p, gcpError: message }));
          }
        }

        if (startProcessing) {
          setProgress((p) => ({ ...p, state: "PROCESSING", fraction: 1 }));
          await processingService.triggerProcessing(surveyId);
          qc.invalidateQueries({ queryKey: queryKeys.job(surveyId) });
        } else {
          setProgress((p) => ({ ...p, state: "COMPLETED", fraction: 1 }));
        }
        return true;
      } catch (err) {
        const d = describeError(err);
        setProgress((p) => ({ ...p, state: "FAILED", error: `${d.title}. ${d.message}` }));
        return false;
      } finally {
        abortRef.current = null;
      }
    },
    [surveyId, qc]
  );

  const uploadAsset = useCallback(
    async (assetType: ImportableAssetType, file: LocalFile) => {
      if (!surveyId) return false;
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress({ ...initial, state: "UPLOADING", totalFiles: 1, currentBatch: 1, totalBatches: 1 });
      try {
        await assetsService.upload(surveyId, assetType, file, {
          signal: controller.signal,
          onProgress: (f) => setProgress((p) => ({ ...p, fraction: f })),
        });
        qc.invalidateQueries({ queryKey: queryKeys.surveyAssets(surveyId) });
        qc.invalidateQueries({ queryKey: queryKeys.surveyAvailability(surveyId) });
        setProgress((p) => ({ ...p, state: "COMPLETED", fraction: 1, uploadedFiles: 1 }));
        return true;
      } catch (err) {
        const d = describeError(err);
        setProgress((p) => ({ ...p, state: "FAILED", error: `${d.title}. ${d.message}` }));
        return false;
      } finally {
        abortRef.current = null;
      }
    },
    [surveyId, qc]
  );

  return { progress, uploadImages, uploadAsset, cancel, reset };
}
