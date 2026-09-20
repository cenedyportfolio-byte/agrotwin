/** One place for every TanStack Query key so invalidation stays consistent. */
export const queryKeys = {
  health: ["health"] as const,
  fields: ["fields"] as const,
  field: (fieldId: string) => ["field", fieldId] as const,
  fieldSurveys: (fieldId: string) => ["field-surveys", fieldId] as const,
  surveys: ["surveys"] as const,
  survey: (surveyId: string) => ["survey", surveyId] as const,
  surveyImages: (surveyId: string) => ["survey-images", surveyId] as const,
  surveyAssets: (surveyId: string) => ["survey-assets", surveyId] as const,
  surveyAvailability: (surveyId: string) => ["survey-availability", surveyId] as const,
  surveyBoundary: (surveyId: string) => ["survey-boundary", surveyId] as const,
  analysis: (surveyId: string) => ["analysis", surveyId] as const,
  job: (surveyId: string) => ["job", surveyId] as const,
};
