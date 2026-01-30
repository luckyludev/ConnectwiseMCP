"""
Configuration management for MCP OAuth Server
"""
import os
from pydantic_settings import BaseSettings
from pydantic import AnyHttpUrl
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables"""
    
    # Auth0 Configuration
    auth0_domain: str
    auth0_client_id: str
    auth0_client_secret: str
    auth0_audience: str
    
    # Server Configuration
    server_url: AnyHttpUrl = "http://localhost:8000"
    server_host: str = "0.0.0.0"
    server_port: int = 8000
    jwt_secret_key: str
    
    # ConnectWise API Configuration
    cw_company_id: str
    cw_public_key: str
    cw_private_key: str
    cw_client_id: str
    cw_api_url: str = "https://api-na.myconnectwise.net/v4_6_release/apis/3.0"
    
    # Derived properties
    @property
    def auth0_issuer_url(self) -> str:
        return f"https://{self.auth0_domain}/"
    
    @property
    def auth0_jwks_url(self) -> str:
        return f"https://{self.auth0_domain}/.well-known/jwks.json"
    
    @property
    def auth0_authorization_url(self) -> str:
        return f"https://{self.auth0_domain}/authorize"
    
    @property
    def auth0_token_url(self) -> str:
        return f"https://{self.auth0_domain}/oauth/token"
    
    @property
    def auth0_userinfo_url(self) -> str:
        return f"https://{self.auth0_domain}/userinfo"
    
    @property
    def cw_auth_header(self) -> str:
        """Generate ConnectWise Basic Auth header"""
        import base64
        credentials = f"{self.cw_company_id}+{self.cw_public_key}:{self.cw_private_key}"
        encoded = base64.b64encode(credentials.encode()).decode()
        return f"Basic {encoded}"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()
