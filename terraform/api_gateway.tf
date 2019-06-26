// On each new function : add to aws_api_gateway_deployment's depends_on related component

resource "aws_api_gateway_rest_api" "api-gateway" {
  name        = "${terraform.workspace}-rest-api"
}

resource "aws_api_gateway_deployment" "api-deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [
  aws_api_gateway_integration.float-api,
  aws_api_gateway_integration.user-activity-api,
  aws_api_gateway_integration.insert_user,
  aws_api_gateway_integration.verify_user
  ]
}



/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "float-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.float-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "float-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "float-api"
}

resource "aws_lambda_permission" "float-api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "float-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.float-api.resource_id}"
  http_method = "${aws_api_gateway_method.float-api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float-api.invoke_arn}"
}

/////////////// USER ACT LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user-activity-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user-activity-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "user-activity-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "user-activity-api"
}

resource "aws_lambda_permission" "user-activity-api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user-activity-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "user-activity-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.user-activity-api.resource_id}"
  http_method = "${aws_api_gateway_method.user-activity-api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user-activity-api.invoke_arn}"
}

/////////////// INSERT USER CREDENTIALS LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "insert_user" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.insert_user.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "insert_user" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "create-new-user"
}

resource "aws_lambda_permission" "insert_user" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.insert-user.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "insert_user" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.insert_user.resource_id}"
  http_method = "${aws_api_gateway_method.insert_user.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.insert-user.invoke_arn}"
}

/////////////// VERIFY USER CREDENTIALS LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "verify_user" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.verify_user.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "verify_user" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "verify-user-credentials"
}

resource "aws_lambda_permission" "verify_user" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.verify-user.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "verify_user" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.verify_user.resource_id}"
  http_method = "${aws_api_gateway_method.verify_user.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.verify-user.invoke_arn}"
}
