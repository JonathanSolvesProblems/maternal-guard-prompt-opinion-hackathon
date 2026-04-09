export const NullUtilities = {
  getOrThrow: <T>(
    obj: T | null | undefined,
    errorMessage: string = "Unexpected null reference",
  ): T => {
    if (obj) {
      return obj;
    }
    throw new Error(errorMessage);
  },
};
