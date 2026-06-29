Pod::Spec.new do |s|
  s.name           = 'AudioLatency'
  s.version        = '1.0.0'
  s.summary        = 'Expo module to read AVAudioSession output latency'
  s.homepage       = 'https://github.com/placeholder'
  s.license        = 'MIT'
  s.author         = 'silentdisco'
  s.platform       = :ios, '15.1'
  s.source         = { git: '' }
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
end
