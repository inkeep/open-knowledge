module.exports = {
  hooks: {
    fetchers: {
      remoteTarball: ({ defaultFetchers }) => {
        process.stderr.write('OK_CLI_FETCH_OBSERVER_V1\n');
        return async (...args) => {
          try {
            return await defaultFetchers.remoteTarball(...args);
          } catch (error) {
            process.stderr.write(
              `OK_CLI_FETCH_FAILURE_V1 ${JSON.stringify({ code: error?.code, status: error?.response?.status })}\n`,
            );
            throw error;
          }
        };
      },
    },
  },
};
