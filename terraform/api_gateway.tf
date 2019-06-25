resource "aws_api_gateway_rest_api" "api-gateway" {
  name        = "${terraform.workspace}-rest-api"
}

resource "aws_api_gateway_deployment" "api-deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [aws_api_gateway_integration.float-api]
}



/////////////// FLOAT API LAMBDA //////////////////////////////////////////////////////////////////////////
resource "aws_api_gateway_method" "float-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.float-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

// example curl -X POST https://iaxlt9v3x1.execute-api.us-east-1.amazonaws.com/staging-stage/user-act-api
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

resource "aws_api_gateway_method" "user-act-api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user-act-api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

// example curl -X POST https://iaxlt9v3x1.execute-api.us-east-1.amazonaws.com/staging-stage/user-act-api
resource "aws_api_gateway_resource" "user-act-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "user-act-api"
}

resource "aws_lambda_permission" "user-act-api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user-act-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_api_gateway_integration" "user-act-api" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.user-act-api.resource_id}"
  http_method = "${aws_api_gateway_method.user-act-api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user-act-api.invoke_arn}"
}