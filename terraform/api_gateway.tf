// On each new function : add to aws_api_gateway_deployment's depends_on related component

resource "aws_api_gateway_rest_api" "api_gateway" {
  name        = "${terraform.workspace}_rest_api"
}

resource "aws_api_gateway_deployment" "api_deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [
  aws_api_gateway_integration.float_api,
  aws_api_gateway_integration.user_activity_api,
  aws_api_gateway_integration.insert_user_credentials,
  aws_api_gateway_integration.verify_user_credentials
  ]
}



/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "float_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.float_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "float_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "float_api"
}

resource "aws_lambda_permission" "float_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api_deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "float_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.float_api.resource_id}"
  http_method = "${aws_api_gateway_method.float_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float_api.invoke_arn}"
}

/////////////// USER ACT LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_activity_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user_activity_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "user_activity_api"
}

resource "aws_lambda_permission" "user_activity_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user_activity_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api_deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.user_activity_api.resource_id}"
  http_method = "${aws_api_gateway_method.user_activity_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user_activity_api.invoke_arn}"
}

/////////////// INSERT USER CREDENTIALS LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "insert_user_credentials" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.insert_user_credentials.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "insert_user_credentials" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "create-new-user"
}

resource "aws_lambda_permission" "insert_user_credentials" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.insert_user_credentials.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api_deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "insert_user_credentials" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.insert_user_credentials.resource_id}"
  http_method = "${aws_api_gateway_method.insert_user_credentials.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.insert_user_credentials.invoke_arn}"
}

/////////////// VERIFY USER CREDENTIALS LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "verify_user_credentials" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.verify_user_credentials.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "verify_user_credentials" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "verify-user-credentials"
}

resource "aws_lambda_permission" "verify_user_credentials" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.verify_user_credentials.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api_deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "verify_user_credentials" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.verify_user_credentials.resource_id}"
  http_method = "${aws_api_gateway_method.verify_user_credentials.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.verify_user_credentials.invoke_arn}"
}
