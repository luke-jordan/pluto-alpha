#! /bin/bash

echo "Running tests and outputing coverage reports"
cd user-existence-api; npm test; npm run-script generate-coverage
cd ../user-activity-api; npm test; npm run-script generate-coverage
cd ../float-api; npm test; npm run-script generate-coverage

echo "Uploading coverage reports"
node_modules/codecov/bin/codecov