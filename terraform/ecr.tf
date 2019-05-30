/*
 * ecr.tf
 * Creates a Amazon Elastic Container Registry (ECR) for the application
 * https://aws.amazon.com/ecr/
 */

# create an ECR repo at the app/image level
resource "aws_ecr_repository" "app" {
  name = "${var.app_name}"
}

data "aws_caller_identity" "current" {}

# grant access to saml users
resource "aws_ecr_repository_policy" "app" {
  repository = "${aws_ecr_repository.app.name}"
  policy     = "${data.aws_iam_policy_document.ecr.json}"
}

data "aws_iam_policy_document" "ecr" {
  statement {
    actions = [
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeRepositories",
      "ecr:GetRepositoryPolicy",
      "ecr:ListImages",
      "ecr:DescribeImages",
      "ecr:DeleteRepository",
      "ecr:BatchDeleteImage",
      "ecr:SetRepositoryPolicy",
      "ecr:DeleteRepositoryPolicy",
      "ecr:GetLifecyclePolicy",
      "ecr:PutLifecyclePolicy",
      "ecr:DeleteLifecyclePolicy",
      "ecr:GetLifecyclePolicyPreview",
      "ecr:StartLifecyclePolicyPreview"
    ]

    principals {
      type = "AWS"

      identifiers = [
        "arn:aws:iam::435708092648:user/_web_app_deployer",
      ]
    }
  }
}