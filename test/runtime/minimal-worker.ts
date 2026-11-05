// Binding-level tests need real storage and Workers APIs, without importing every route
// and Workflow from the application entrypoint. This Worker is never an HTTP test target.
export default {
  fetch(): Response {
    throw new Error('The minimal test Worker cannot serve application requests.');
  },
} satisfies ExportedHandler;
