const logger = require('debug')('jupiter:migration:run_migrations');
const {migrate} = require("postgres-migrations")
const migrationScriptsLocation = "scripts";

logger('running migrations');

// TODO:
// pass the db variables
// run on deploying the function
migrate({
    database: "testing-migrations",
    user: "admin",
    password: "admin",
    host: "localhost",
    port: 5430,
  }, migrationScriptsLocation)
.then(() => {
    logger('migrations ran successfully');
})
.catch((error) => {
  logger('Error occurred while running migrations: ', error);
});