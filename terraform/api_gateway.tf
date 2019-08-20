// On each new function : add to aws_api_gateway_deployment's depends_on related component

resource "aws_api_gateway_rest_api" "api_gateway" {
  name        = "${terraform.workspace}_rest_api"
  
}

resource "aws_api_gateway_deployment" "api_deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${terraform.workspace}"

  depends_on = [
  aws_api_gateway_integration.save_initiate,
  aws_api_gateway_integration.save_payment_check,
  aws_api_gateway_integration.balance_fetch_wrapper,
  aws_api_gateway_integration.message_token_store,
  aws_api_gateway_integration.ops_warmup
  ]

  variables = {
    commit_sha1 = "${var.deploy_code_commit_hash}"
  }

  lifecycle {
    create_before_destroy = true
  }
}

/////////////////////// API GW AUTHORIZER ///////////////////////////////////////////////////////////////

resource "aws_api_gateway_authorizer" "jwt_authorizer" {
  name = "api_gateway_jwt_authorizer_${terraform.workspace}"
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  type = "TOKEN"
  authorizer_uri = "arn:aws:apigateway:${var.aws_default_region[terraform.workspace]}:lambda:path/2015-03-31/functions/${var.jwt_authorizer_arn}/invocations"
}

resource "aws_iam_role" "auth_invocation_role" {
  name = "api_gateway_auth_invocation"
  path = "/"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "apigateway.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "invocation_policy" {
  name = "default"
  role = "${aws_iam_role.auth_invocation_role.id}"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "lambda:InvokeFunction",
      "Effect": "Allow",
      "Resource": "${var.jwt_authorizer_arn}"
    }
  ]
}
EOF
}

/////////////////////// API GW LOGGING ///////////////////////////////////////////////////////////////
resource "aws_api_gateway_account" "api_gateway" {
  cloudwatch_role_arn = "${aws_iam_role.api_gateway_cloudwatch.arn}"

  depends_on = [aws_iam_role.api_gateway_cloudwatch]
}

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "api_gateway_cloudwatch_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "",
      "Effect": "Allow",
      "Principal": {
        "Service": "apigateway.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "api_gateway_cloudwatch" {
  name = "default"
  role = "${aws_iam_role.api_gateway_cloudwatch.id}"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
                "logs:GetLogEvents",
                "logs:FilterLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
EOF
}

resource "aws_api_gateway_method_settings" "general_settings" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.api_deployment.stage_name}"
  method_path = "*/*"

  settings {
    # Enable CloudWatch logging and metrics
    metrics_enabled        = true
    data_trace_enabled     = true
    logging_level          = "INFO"

    # Limit the rate of calls to prevent abuse and unwanted charges
    throttling_rate_limit  = 100
    throttling_burst_limit = 50
  }
}

/////////////////////// API GW DOMAIN ////////////////////////////////////////////////////////////////

resource "aws_api_gateway_domain_name" "custom_doname_name" {
  certificate_arn = "arn:aws:acm:us-east-1:455943420663:certificate/6fb77289-8ee8-420a-8f5b-6d62782e091e"
  domain_name     = "${terraform.workspace}.jupiterapp.net"
}

resource "aws_route53_record" "route" {
  name    = "${aws_api_gateway_domain_name.custom_doname_name.domain_name}"
  type    = "A"
  zone_id = "Z32F5PRK3A4ONK"

  alias {
    evaluate_target_health = true
    name                   = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_domain_name}"
    zone_id                = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_zone_id}"
  }
}

resource "aws_api_gateway_base_path_mapping" "custom_resourse_mapping" {
  api_id      = "${aws_api_gateway_rest_api.api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.api_deployment.stage_name}"
  domain_name = "${aws_api_gateway_domain_name.custom_doname_name.domain_name}"
}

/////////////// SAVE API LAMBDA (INITIATE & CHECK) //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "save_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "addcash"
}

resource "aws_api_gateway_resource" "save_initiate" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.save_path_root.id}"
  path_part   = "initiate"
}

resource "aws_api_gateway_method" "save_initiate" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.save_initiate.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.jwt_authorizer.id}"
}

resource "aws_lambda_permission" "save_initiate" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.save_initiate.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_initiate" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.save_initiate.resource_id}"
  http_method = "${aws_api_gateway_method.save_initiate.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.save_initiate.invoke_arn}"
}

resource "aws_api_gateway_resource" "save_payment_check" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.save_path_root.id}"
  path_part   = "check"
}

resource "aws_api_gateway_method" "save_payment_check" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.save_payment_check.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.jwt_authorizer.id}"
}

resource "aws_lambda_permission" "save_payment_check" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.save_payment_check.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_payment_check" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.save_payment_check.resource_id}"
  http_method = "${aws_api_gateway_method.save_payment_check.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.save_payment_check.invoke_arn}"
}

/////////////// ACCOUNT BALANCE LAMBDA (WRAPPER ONLY, SIMPLE GET) -- MAIN LAMBDA ONLY FOR INVOKE /////////////////////////////////////////////////

resource "aws_api_gateway_method" "balance_fetch_wrapper" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.balance_fetch_wrapper.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.jwt_authorizer.id}"
}

resource "aws_api_gateway_resource" "balance_fetch_wrapper" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "balance"
}

resource "aws_lambda_permission" "balance_fetch_wrapper" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.balance_fetch_wrapper.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "balance_fetch_wrapper" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.balance_fetch_wrapper.resource_id}"
  http_method = "${aws_api_gateway_method.balance_fetch_wrapper.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.balance_fetch_wrapper.invoke_arn}"
}

/////////////// MESSAGING LAMBDAS //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "message_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "message"
}

resource "aws_api_gateway_resource" "message_token_store" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.message_path_root.id}"
  path_part   = "token"
}

resource "aws_api_gateway_method" "message_token_store" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.message_token_store.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.jwt_authorizer.id}"
}

resource "aws_lambda_permission" "message_token_store" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_token_store.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_token_store" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.message_token_store.resource_id}"
  http_method = "${aws_api_gateway_method.message_token_store.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_token_store.invoke_arn}"
}


/////////////// WARMUP LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "ops_warmup" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.ops_warmup.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "ops_warmup" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "warmup"
}

resource "aws_lambda_permission" "ops_warmup" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.ops_warmup.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "ops_warmup" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.ops_warmup.resource_id}"
  http_method = "${aws_api_gateway_method.ops_warmup.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.ops_warmup.invoke_arn}"
}
