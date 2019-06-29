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
  aws_api_gateway_integration.user_existence_api,
  aws_api_gateway_integration.insert_user_credentials,
  aws_api_gateway_integration.verify_user_credentials,
  aws_api_gateway_integration.update_password,
  aws_api_gateway_integration.verify_jwt,
  aws_api_gateway_integration.sign_jwt
  ]

  variables = {
    commit_sha1 = "${var.deploy_code_commit_hash}"
  }

  lifecycle {
    create_before_destroy = true
  }
}

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
  path_part   = "float-api"
}

resource "aws_lambda_permission" "float_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "float_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.float_api.resource_id}"
  http_method = "${aws_api_gateway_method.float_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float_api.invoke_arn}"
}

/////////////// USER ACTIVITY API LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_activity_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user_activity_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "user-activity-api"
}

resource "aws_lambda_permission" "user_activity_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user_activity_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_activity_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.user_activity_api.resource_id}"
  http_method = "${aws_api_gateway_method.user_activity_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user_activity_api.invoke_arn}"
}

/////////////// USER EXISTENCE API LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_existence_api" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.user_existence_api.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "user_existence_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "user-existence-api"
}

resource "aws_lambda_permission" "user_existence_api" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user_existence_api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_existence_api" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.user_existence_api.resource_id}"
  http_method = "${aws_api_gateway_method.user_existence_api.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.user_existence_api.invoke_arn}"
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
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
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
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "verify_user_credentials" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.verify_user_credentials.resource_id}"
  http_method = "${aws_api_gateway_method.verify_user_credentials.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.verify_user_credentials.invoke_arn}"
}

/////////////// UPDATE USER PASSWORD LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "update_password" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.update_password.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "update_password" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "update-password"
}

resource "aws_lambda_permission" "update_password" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.update_password.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "update_password" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.update_password.resource_id}"
  http_method = "${aws_api_gateway_method.update_password.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.update_password.invoke_arn}"
}

/////////////// VERIFY JWT LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "verify_jwt" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.verify_jwt.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "verify_jwt" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "verify-jwt"
}

resource "aws_lambda_permission" "verify_jwt" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.verify_jwt.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "verify_jwt" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.verify_jwt.resource_id}"
  http_method = "${aws_api_gateway_method.verify_jwt.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.verify_jwt.invoke_arn}"

}

/////////////// SIGN JWT LAMBDA //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "sign_jwt" {
  rest_api_id   = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.sign_jwt.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_resource" "sign_jwt" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api_gateway.root_resource_id}"
  path_part   = "sign-jwt"
}

resource "aws_lambda_permission" "sign_jwt" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.sign_jwt.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "sign_jwt" {
  rest_api_id = "${aws_api_gateway_rest_api.api_gateway.id}"
  resource_id = "${aws_api_gateway_method.sign_jwt.resource_id}"
  http_method = "${aws_api_gateway_method.sign_jwt.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.sign_jwt.invoke_arn}"

}