terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# Primary region — Ireland, lowest latency to Netherlands
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.app_name
      ManagedBy = "terraform"
    }
  }
}

# ACM certificates for CloudFront must be in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.app_name
      ManagedBy = "terraform"
    }
  }
}

data "aws_route53_zone" "zone" {
  name         = var.route53_zone_name
  private_zone = false
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
